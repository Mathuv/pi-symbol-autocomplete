/**
 * Symbol reference resolver.
 *
 * Maps parsed references to concrete ProjectSymbols through exact
 * readtags scans, following deterministic resolution rules:
 *
 * - **Stable token** (`#name@path:line`):
 *   1. Exact match on name + path + line → resolved
 *   2. Same name + same file (stale line) → stale-resolved
 *   3. Otherwise → unresolved (no cross-file fallback)
 *
 * - **Plain token** (`#name`):
 *   - Exactly one symbol with that name → resolved
 *   - Multiple symbols with that name → ambiguous (skip injection)
 *   - No symbol with that name → unresolved
 *
 * - **Dotted tokens** (`#Parent.member` or `#Parent.member@path:line`):
 *   - Dotted stable: match by parent + member + path + line (exact)
 *   - Dotted stale stable: same parent + member + file (stale line)
 *   - Dotted plain: match by parent + member (unique → resolved, multiple → ambiguous)
 *
 * The backend runs one streamed scan per distinct tag name. Repeated
 * references within one call share the scan. At most 8 distinct names
 * are admitted, in first-reference order; references for later distinct
 * names resolve locally as omitted by the limit. The admitted scans run
 * concurrently, at most 8. One 5 s total deadline bounds alias loading
 * and every admitted scan. Each reference retains at most two
 * candidates, so memory stays constant regardless of how many tags
 * share a name.
 */

import type {
  ParsedReference,
  ProjectSymbol,
  ReadtagsBackend,
  ResolveResult,
  ResolvedReference,
} from "./types.ts";

// ── Bounds ──────────────────────────────────────────────────────────

/** Distinct lookup names admitted before any subprocess creation. */
const MAX_LOOKUP_NAMES = 8;
/** One total deadline across alias loading and all admitted scans. */
const RESOLVE_DEADLINE_MS = 5_000;

// ── Bounded candidate state ─────────────────────────────────────────

/**
 * Plain-like references keep the first two candidates. The second
 * candidate already proves ambiguity; `multiple` records when more
 * candidates arrive so the diagnostic can say so.
 */
interface PlainCandidates {
  candidates: ProjectSymbol[];
  multiple: boolean;
}

/**
 * Stable references keep the first exact name+path+line candidate and
 * the first same-name same-path candidate (stale fallback). Two slots
 * are enough to decide resolved/stale/unresolved.
 */
interface StableCandidates {
  exact: ProjectSymbol | null;
  stale: ProjectSymbol | null;
}

type GroupMember =
  | {
      kind: "plain";
      ref: ParsedReference;
      dotted?: { parentName: string; memberName: string };
      state: PlainCandidates;
    }
  | {
      kind: "stable";
      ref: ParsedReference;
      dotted?: { parentName: string; memberName: string };
      state: StableCandidates;
    };

interface KeyGroup {
  key: string;
  members: GroupMember[];
}

type OrderedSlot =
  | { kind: "local"; result: ResolvedReference }
  | { kind: "member"; member: GroupMember };

// ── Public API ──────────────────────────────────────────────────────

/**
 * Resolve parsed references against the readtags backend.
 *
 * References are grouped by the exact tag name they need, so one scan
 * serves every reference in the group. Multi-dot and malformed stable
 * references resolve locally without a scan.
 *
 * Returns structured outcomes with diagnostic metadata, including an
 * `injectable` subset of references that passed ambiguity/uniqueness checks.
 *
 * `deadlineMs` bounds every admitted scan together. Only tests set it;
 * production keeps the 5 s default.
 */
export async function resolveReferences(
  references: ParsedReference[],
  backend: ReadtagsBackend,
  options?: { deadlineMs?: number },
): Promise<ResolveResult> {
  const groups = new Map<string, KeyGroup>();
  const ordered: OrderedSlot[] = [];

  for (const ref of references) {
    const dotted = splitDottedName(ref.name);
    const key = groupKey(ref, dotted);
    if (key === null) {
      ordered.push({ kind: "local", result: localUnresolved(ref, dotted) });
      continue;
    }

    const group = groups.get(key);
    if (group) {
      const member = makeMember(ref, dotted);
      group.members.push(member);
      ordered.push({ kind: "member", member });
      continue;
    }

    // Admit at most 8 distinct lookup names, in first-reference order,
    // before any subprocess creation.
    if (groups.size >= MAX_LOOKUP_NAMES) {
      ordered.push({ kind: "local", result: limitUnresolved(ref, dotted) });
      continue;
    }

    const admitted: KeyGroup = { key, members: [] };
    const member = makeMember(ref, dotted);
    admitted.members.push(member);
    groups.set(key, admitted);
    ordered.push({ kind: "member", member });
  }

  // One scanExact call per admitted key. The scans run concurrently, at
  // most 8, under ONE total deadline. Each group writes only its own
  // members, so the callbacks stay independent. A deadline abort rejects
  // the active scans and this call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.deadlineMs ?? RESOLVE_DEADLINE_MS);
  try {
    await Promise.all(
      [...groups.values()].map((group) =>
        backend.scanExact(group.key, (symbol) => {
          for (const member of group.members) updateCandidates(member, symbol);
        }, controller.signal),
      ),
    );
  } finally {
    clearTimeout(timer);
    // One rejected scan rejects this call at once. Abort the shared
    // controller, so no sibling scan streams on until the deadline.
    // After a full success the abort has no observers.
    controller.abort();
  }

  const resolved = ordered.map((slot) =>
    slot.kind === "local" ? slot.result : deriveResult(slot.member),
  );

  return {
    resolved,
    injectable: resolved.filter((r) => r.status === "resolved" || r.status === "stale"),
  };
}

// ── Internal resolution logic ───────────────────────────────────────

/** Build the bounded candidate state for one reference. */
function makeMember(
  ref: ParsedReference,
  dotted: { parentName: string; memberName: string } | null,
): GroupMember {
  const shared = { ref, dotted: dotted ?? undefined };
  return ref.type === "stable"
    ? { ...shared, kind: "stable" as const, state: { exact: null, stale: null } }
    : { ...shared, kind: "plain" as const, state: { candidates: [], multiple: false } };
}

/**
 * Return the exact tag name a reference scans, or null when it resolves
 * locally. Multi-dot names and malformed stable tokens need no scan.
 */
function groupKey(
  ref: ParsedReference,
  dotted: { parentName: string; memberName: string } | null,
): string | null {
  if (dotted) {
    if (ref.type === "stable" && (ref.path === undefined || ref.line === undefined)) {
      return null;
    }
    return dotted.memberName;
  }
  // Multi-dot names (e.g. A.B.C) are unsupported chains in v1.
  // splitDottedName returned null because the member contains more dots.
  if (ref.name.includes(".")) return null;
  if (ref.type === "stable" && (ref.path === undefined || ref.line === undefined)) {
    return null;
  }
  return ref.name;
}

/** Build the local unresolved outcome for multi-dot and malformed refs. */
function localUnresolved(
  ref: ParsedReference,
  dotted: { parentName: string; memberName: string } | null,
): ResolvedReference {
  let message: string;
  if (dotted) {
    message = "Malformed dotted stable token: missing path or line";
  } else if (ref.name.includes(".")) {
    message = `Unresolved multi-dot reference: "${ref.name}" — dotted chains with more than one dot are not supported in v1`;
  } else {
    message = "Malformed stable token: missing path or line";
  }
  return { parsed: ref, symbol: null, status: "unresolved", message };
}

/** Build the unresolved outcome for a name omitted by the lookup limit. */
function limitUnresolved(
  ref: ParsedReference,
  dotted: { parentName: string; memberName: string } | null,
): ResolvedReference {
  const label = dotted ? `${dotted.parentName}.${dotted.memberName}` : ref.name;
  return {
    parsed: ref,
    symbol: null,
    status: "unresolved",
    message: `Unresolved ${label}: the 8-name lookup limit omitted this reference`,
  };
}

/**
 * Split a dotted name into parent and member parts.
 * Returns null if the name doesn't contain a valid dot separation.
 * The autocomplete provider shares this rule, so `#Parent.`, `#.foo`,
 * and `#A.B.C` behave the same in both places.
 */
export function splitDottedName(name: string): { parentName: string; memberName: string } | null {
  const dotIndex = name.indexOf(".");
  if (dotIndex <= 0 || dotIndex >= name.length - 1) {
    return null;
  }
  const memberName = name.slice(dotIndex + 1);
  // v1 supports exactly one parent plus one member; reject multi-dot chains
  if (memberName.includes(".")) {
    return null;
  }
  return {
    parentName: name.slice(0, dotIndex),
    memberName,
  };
}

/** Return true when the symbol matches the reference identity. */
function matchesIdentity(member: GroupMember, symbol: ProjectSymbol): boolean {
  return member.dotted
    ? symbol.parentName === member.dotted.parentName &&
        symbol.name === member.dotted.memberName
    : symbol.name === member.ref.name;
}

/**
 * Fold one streamed symbol into a reference's bounded candidate state.
 * Plain references keep the first two candidates; stable references
 * keep the first exact and the first same-file candidate.
 */
function updateCandidates(member: GroupMember, symbol: ProjectSymbol): void {
  if (!matchesIdentity(member, symbol)) return;

  if (member.kind === "stable") {
    if (
      member.state.exact === null &&
      symbol.path === member.ref.path &&
      symbol.line === member.ref.line
    ) {
      member.state.exact = symbol;
    }
    if (member.state.stale === null && symbol.path === member.ref.path) {
      member.state.stale = symbol;
    }
    return;
  }

  if (member.state.candidates.length < 2) member.state.candidates.push(symbol);
  else member.state.multiple = true;
}

/** Derive the resolution outcome from the retained candidates. */
function deriveResult(member: GroupMember): ResolvedReference {
  const { ref, dotted } = member;
  const label = dotted ? `${dotted.parentName}.${dotted.memberName}` : ref.name;

  if (member.kind === "stable") {
    if (member.state.exact) {
      return {
        parsed: ref,
        symbol: member.state.exact,
        status: "resolved",
        message: dotted
          ? `Resolved via exact parent+member+path+line: ${label}@${member.state.exact.path}:${member.state.exact.line}`
          : `Resolved via exact name+path+line: ${label}@${member.state.exact.path}:${member.state.exact.line}`,
      };
    }
    if (member.state.stale) {
      return {
        parsed: ref,
        symbol: member.state.stale,
        status: "stale",
        message: `Stable token line ${ref.line} is stale; resolved to ${label} at ${member.state.stale.path}:${member.state.stale.line}`,
      };
    }
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: `Unresolved ${dotted ? "dotted " : ""}stable token: ${label} not found at ${ref.path}:${ref.line}`,
    };
  }

  if (member.state.candidates.length === 1) {
    const symbol = member.state.candidates[0];
    return {
      parsed: ref,
      symbol,
      status: "resolved",
      message: dotted
        ? `Resolved unique dotted match: ${label} → ${symbol.path}:${symbol.line}`
        : `Resolved unique match: ${label} → ${symbol.path}:${symbol.line}`,
    };
  }

  if (member.state.candidates.length === 0) {
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: dotted
        ? `Unresolved dotted plain token: no symbol with parent="${dotted.parentName}" and name="${dotted.memberName}"`
        : `Unresolved plain token: no symbol named "${ref.name}"`,
    };
  }

  // Two or more matches. The diagnostic lists only the retained paths.
  const paths = member.state.candidates.map((s) => `${s.path}:${s.line}`).join(", ");
  const extra = member.state.multiple ? " (more than two matches)" : "";
  return {
    parsed: ref,
    symbol: null,
    status: "ambiguous",
    message: dotted
      ? `Ambiguous dotted plain token: "${label}" matches multiple symbols${extra}: ${paths}`
      : `Ambiguous plain token: "${ref.name}" matches multiple symbols${extra}: ${paths}`,
  };
}

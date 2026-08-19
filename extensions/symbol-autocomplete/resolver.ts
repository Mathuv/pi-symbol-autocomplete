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
 * references within one call share the scan. Each reference retains at
 * most two candidates, so memory stays constant regardless of how many
 * tags share a name.
 */

import type {
  ParsedReference,
  ProjectSymbol,
  ReadtagsBackend,
  ResolveResult,
  ResolvedReference,
} from "./types.ts";

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

type CandidateState = PlainCandidates | StableCandidates;

interface GroupMember {
  ref: ParsedReference;
  /** True for stable tokens (exact path+line, else stale fallback). */
  isStable: boolean;
  /** Split parts for dotted members. */
  dotted?: { parentName: string; memberName: string };
  state: CandidateState;
}

interface KeyGroup {
  key: string;
  members: GroupMember[];
}

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
 */
export async function resolveReferences(
  references: ParsedReference[],
  backend: ReadtagsBackend,
): Promise<ResolveResult> {
  const groups = new Map<string, KeyGroup>();
  const ordered: Array<
    | { kind: "local"; result: ResolvedReference }
    | { kind: "member"; member: GroupMember }
  > = [];

  for (const ref of references) {
    const dotted = splitDottedName(ref.name);
    const key = groupKey(ref, dotted);
    if (key === null) {
      ordered.push({ kind: "local", result: localUnresolved(ref, dotted) });
      continue;
    }

    let group = groups.get(key);
    if (!group) {
      group = { key, members: [] };
      groups.set(key, group);
    }
    const member: GroupMember = {
      ref,
      isStable: ref.type === "stable",
      dotted: dotted ?? undefined,
      state: ref.type === "stable"
        ? { exact: null, stale: null }
        : { candidates: [], multiple: false },
    };
    group.members.push(member);
    ordered.push({ kind: "member", member });
  }

  // One scanExact call per distinct key, sequential.
  for (const group of groups.values()) {
    await backend.scanExact(group.key, (symbol) => {
      for (const member of group.members) updateCandidates(member, symbol);
    });
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

/**
 * Split a dotted name into parent and member parts.
 * Returns null if the name doesn't contain a valid dot separation.
 */
function splitDottedName(name: string): { parentName: string; memberName: string } | null {
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

  if (member.isStable) {
    const stable = member.state as StableCandidates;
    if (
      stable.exact === null &&
      symbol.path === member.ref.path &&
      symbol.line === member.ref.line
    ) {
      stable.exact = symbol;
    }
    if (stable.stale === null && symbol.path === member.ref.path) {
      stable.stale = symbol;
    }
    return;
  }

  const plain = member.state as PlainCandidates;
  if (plain.candidates.length < 2) plain.candidates.push(symbol);
  else plain.multiple = true;
}

/** Derive the resolution outcome from the retained candidates. */
function deriveResult(member: GroupMember): ResolvedReference {
  const { ref, isStable, dotted } = member;
  const label = dotted ? `${dotted.parentName}.${dotted.memberName}` : ref.name;

  if (isStable) {
    const stable = member.state as StableCandidates;
    if (stable.exact) {
      return {
        parsed: ref,
        symbol: stable.exact,
        status: "resolved",
        message: dotted
          ? `Resolved via exact parent+member+path+line: ${label}@${stable.exact.path}:${stable.exact.line}`
          : `Resolved via exact name+path+line: ${label}@${stable.exact.path}:${stable.exact.line}`,
      };
    }
    if (stable.stale) {
      return {
        parsed: ref,
        symbol: stable.stale,
        status: "stale",
        message: `Stable token line ${ref.line} is stale; resolved to ${label} at ${stable.stale.path}:${stable.stale.line}`,
      };
    }
    return {
      parsed: ref,
      symbol: null,
      status: "unresolved",
      message: `Unresolved ${dotted ? "dotted " : ""}stable token: ${label} not found at ${ref.path}:${ref.line}`,
    };
  }

  const plain = member.state as PlainCandidates;
  if (plain.candidates.length === 1) {
    const symbol = plain.candidates[0];
    return {
      parsed: ref,
      symbol,
      status: "resolved",
      message: dotted
        ? `Resolved unique dotted match: ${label} → ${symbol.path}:${symbol.line}`
        : `Resolved unique match: ${label} → ${symbol.path}:${symbol.line}`,
    };
  }

  if (plain.candidates.length === 0) {
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
  const paths = plain.candidates.map((s) => `${s.path}:${s.line}`).join(", ");
  const extra = plain.multiple ? " (more than two matches)" : "";
  return {
    parsed: ref,
    symbol: null,
    status: "ambiguous",
    message: dotted
      ? `Ambiguous dotted plain token: "${label}" matches multiple symbols${extra}: ${paths}`
      : `Ambiguous plain token: "${ref.name}" matches multiple symbols${extra}: ${paths}`,
  };
}

// D8 declaration and the fixed Bun JUnit producer's execution evidence share these rules.
export function d8ConsumerCases(entry) {
  const cases = entry?.enforced_by?.consumer_cases;
  if (
    !Array.isArray(cases) ||
    cases.length === 0 ||
    cases.some((id) => typeof id !== 'string' || !/^D8\.[a-z][a-z0-9.-]*$/.test(id)) ||
    new Set(cases).size !== cases.length
  ) {
    throw new Error('D8: consumer_cases must contain unique D8 consumer IDs');
  }
  return cases;
}

// This consumes our pinned Bun's report, not arbitrary XML or an external attestation.
// Track nesting before reading cases: extracting passing substrings would accept a truncated report.
export function assertD8Report(report, entry) {
  const required = d8ConsumerCases(entry);
  if (entry.status !== 'enforced')
    throw new Error('D8: runtime report requires enforced declaration');
  const stack = [];
  const cases = new Map();
  let current = null;
  let roots = 0;
  let expectedTests = -1;
  let actualTests = 0;
  let cursor = 0;
  const malformed = () => {
    throw new Error('D8: malformed or incomplete Bun execution report');
  };
  for (const match of report.matchAll(/<[^>]*>/g)) {
    const between = report.slice(cursor, match.index);
    if (between.includes('<') || (stack.length === 0 && between.trim())) malformed();
    const token = match[0];
    cursor = match.index + token.length;
    if (/^<\?xml\s[^?]*\?>$/.test(token) && roots === 0 && stack.length === 0) continue;
    const closing = /^<\/([A-Za-z][\w.-]*)\s*>$/.exec(token);
    if (closing) {
      if (stack.pop() !== closing[1]) malformed();
      if (closing[1] === 'testcase') current = null;
      continue;
    }
    const opening = /^<([A-Za-z][\w.-]*)([\s\S]*?)>$/.exec(token);
    if (!opening) malformed();
    const [, name, attributes] = opening;
    if (stack.length === 0) {
      if (name !== 'testsuites' || roots++ !== 0) malformed();
      const count = /(?:^|\s)tests="([0-9]+)"/.exec(attributes);
      expectedTests = Number(count?.[1]);
      if (!Number.isSafeInteger(expectedTests)) malformed();
    }
    if (name === 'testcase') {
      if (stack.at(-1) !== 'testsuite' || current !== null) malformed();
      const identity = /(?:^|\s)name="([^"]*)"/.exec(attributes);
      if (!identity) malformed();
      current = { blocked: false };
      const entries = cases.get(identity[1]) ?? [];
      entries.push(current);
      cases.set(identity[1], entries);
      actualTests++;
    }
    if (current && ['skipped', 'failure', 'error'].includes(name)) current.blocked = true;
    if (!token.endsWith('/>')) stack.push(name);
    else if (name === 'testcase') current = null;
  }
  if (
    roots !== 1 ||
    stack.length !== 0 ||
    report.slice(cursor).trim() ||
    actualTests !== expectedTests
  )
    malformed();
  for (const id of required) {
    const entries = cases.get(id) ?? [];
    if (entries.length !== 1 || entries[0].blocked) {
      throw new Error(
        `D8: required consumer ${id} must appear exactly once and pass without skipping`,
      );
    }
  }
  return required;
}

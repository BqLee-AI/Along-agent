/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "time-core-zero-egress",
      comment:
        "D1: packages/time-core/src MUST NOT import anything (zero outgoing deps).",
      severity: "error",
      from: { path: "packages/time-core/src" },
      to: { pathNot: "packages/time-core/src" },
    },
    {
      name: "contracts-zod-only",
      comment: "packages/contracts/src MUST depend only on zod.",
      severity: "error",
      from: { path: "packages/contracts/src" },
      to: { pathNot: "(packages/contracts/src|node_modules/zod)" },
    },
    {
      name: "no-circular",
      comment: "No circular dependencies in the monorepo.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};

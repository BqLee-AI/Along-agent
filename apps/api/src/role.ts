export type Role = "api" | "worker" | "all";

const ROLES: Role[] = ["api", "worker", "all"];

export function parseRole(raw: string | undefined): Role {
  const value = (raw ?? "all").trim().toLowerCase();
  const found = ROLES.find((r) => r === value);
  if (!found) {
    throw new Error(
      `invalid ROLE ${JSON.stringify(raw)}: expected one of api|worker|all`,
    );
  }
  return found;
}

export function buildVerificationContract({ goal, acceptance = [], checks = [] }) {
  return { goal, acceptance, checks, createdAt: Date.now() };
}

export function verifyGate(result) {
  if (!result?.pass) throw new Error('verification gate failed');
  return true;
}

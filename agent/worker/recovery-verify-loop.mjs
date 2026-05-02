import { withHttpAutoRetry } from './error-recovery.mjs';
export async function recoverThenVerify(recoverFn, verifyFn) {
  await withHttpAutoRetry(async () => recoverFn());
  return verifyFn();
}

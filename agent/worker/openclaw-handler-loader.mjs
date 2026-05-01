// R97 compatibility loader.
// The legacy implementation is materialized as a normal JS module so it can be
// imported, linted, checked and debugged without data:URL code generation.
import * as legacyModule from './openclaw-handler.legacy.mjs';

export { legacyModule };
export const handleViaOpenClaw = legacyModule.handleViaOpenClaw;
export const cleanupOpenClawHandlerResources = legacyModule.cleanupOpenClawHandlerResources;

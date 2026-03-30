/**
 * Re-export barrel for stage prompts.
 *
 * Individual prompts are in separate files for maintainability.
 * This file preserves the existing import paths.
 */

export { workingEnv, CODING_STANDARDS } from "./shared";
export { constructScoutPrompt, constructScoutCompactPrompt } from "./scout";
export { constructImplementPrompts } from "./implement";
export { constructTestWritePrompts } from "./test-write";
export { type ReviewLens, REVIEW_LENSES, constructReviewPrompts } from "./review";

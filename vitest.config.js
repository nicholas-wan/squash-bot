import { defineConfig } from 'vitest/config';

// Only this project's tests. Without the include, vitest also walks the agent
// worktrees under .claude/worktrees and runs every stale copy it finds: from
// the main checkout that was 196 files instead of 17, and one broken old copy
// would have blocked `npm run deploy`, which runs the tests first.
export default defineConfig({
  test: { include: ['test/**/*.test.js'] },
});

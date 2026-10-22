/**
 * Jest config for the Traccer API. No committed config existed, so `npm test`
 * (plain `jest`) could not transform TypeScript specs. This runs every `*.spec.ts`
 * under src/ with ts-jest. forceExit avoids hangs from @Interval/@Cron timers and the
 * Socket.IO gateway that keep the event loop alive in integration tests.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  forceExit: true,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true }],
  },
};

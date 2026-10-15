module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Needs DynamoDB Local; runs with `npm run test:int`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/integration/'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // The infra tests bundle the two Lambda functions with esbuild.
  testTimeout: 120000,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};

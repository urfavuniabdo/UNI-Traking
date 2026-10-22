module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '\\.spec\\.ts$|\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { target: 'ES2022', module: 'commonjs', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, allowJs: false } }],
  },
  testTimeout: 30000,
  maxWorkers: 1,
};

import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  testEnvironmentOptions: {
    url: "http://localhost/",
  },
  roots: ["<rootDir>/src"],
  modulePathIgnorePatterns: ["<rootDir>/dist"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^yaml$": "<rootDir>/node_modules/yaml/dist/index.js",
  },
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { useESM: false }],
  },
  transformIgnorePatterns: [
    "node_modules/(?!(yaml)/)",
  ],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
};

export default config;

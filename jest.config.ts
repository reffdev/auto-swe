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
  },
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { useESM: false }],
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
};

export default config;

export default {
    testEnvironment: 'node',
    transformIgnorePatterns: [
        'node_modules/(?!(@polkadot|orbit-db)/)'
    ],
    transform: {
        '^.+\\.(js|mjs)$': 'babel-jest',
    },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1'
    },
    testMatch: [
        "**/tests/**/*.test.mjs"
    ],
    verbose: true
};
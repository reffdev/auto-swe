import '@testing-library/jest-dom'

// Polyfill for TextEncoder/TextDecoder which are required by react-router
global.TextEncoder = require('util').TextEncoder
global.TextDecoder = require('util').TextDecoder

// Polyfill for ReadableStream which is required by @langchain/core
global.ReadableStream = require('stream').Readable

// Polyfill for setImmediate which is required by express/router
global.setImmediate = (cb: () => void) => setTimeout(cb, 0)

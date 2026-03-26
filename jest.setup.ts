import '@testing-library/jest-dom'

// Polyfill for TextEncoder/TextDecoder which are required by react-router
global.TextEncoder = require('util').TextEncoder
global.TextDecoder = require('util').TextDecoder

// Polyfill for ReadableStream and TransformStream which are required by @langchain/core
global.ReadableStream = require('stream/web').ReadableStream
global.TransformStream = require('stream/web').TransformStream

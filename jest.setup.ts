import '@testing-library/jest-dom'

// Polyfill for TextEncoder/TextDecoder which are required by react-router
global.TextEncoder = require('util').TextEncoder
global.TextDecoder = require('util').TextDecoder

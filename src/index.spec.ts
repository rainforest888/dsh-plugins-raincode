import { describe, it, expect } from 'vitest'
import { isLoopbackBaseURL } from './index.js'

describe('isLoopbackBaseURL', () => {
  it('recognizes loopback hosts', () => {
    expect(isLoopbackBaseURL('http://127.0.0.1:8787')).toBe(true)
    expect(isLoopbackBaseURL('http://localhost:8787/v1')).toBe(true)
    expect(isLoopbackBaseURL('http://[::1]:4040')).toBe(true)
  })

  it('rejects remote hosts and garbage', () => {
    expect(isLoopbackBaseURL('https://api.example.com/v1')).toBe(false)
    expect(isLoopbackBaseURL('not a url')).toBe(false)
  })
})

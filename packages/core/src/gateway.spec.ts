import { describe, expect, it } from 'vitest'
import { gatewayBin, isLoopbackBaseURL, pluginRegistryPath } from './gateway.js'

describe('gatewayBin', () => {
  it('prefers an explicit setting', () => {
    expect(gatewayBin('/opt/raincode/bin/raincode')).toBe('/opt/raincode/bin/raincode')
  })

  it('falls back to RAINCODE_BIN when the setting is empty', () => {
    const previous = process.env.RAINCODE_BIN
    process.env.RAINCODE_BIN = '/tmp/custom-raincode'
    try {
      expect(gatewayBin('')).toBe('/tmp/custom-raincode')
      expect(gatewayBin(undefined)).toBe('/tmp/custom-raincode')
    } finally {
      if (previous === undefined) delete process.env.RAINCODE_BIN
      else process.env.RAINCODE_BIN = previous
    }
  })

  it('never returns an empty string when nothing is configured', () => {
    const previous = process.env.RAINCODE_BIN
    delete process.env.RAINCODE_BIN
    try {
      expect(gatewayBin('')).not.toBe('')
    } finally {
      if (previous !== undefined) process.env.RAINCODE_BIN = previous
    }
  })
})

describe('isLoopbackBaseURL', () => {
  it.each(['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787'])('accepts %s', (url) => {
    expect(isLoopbackBaseURL(url)).toBe(true)
  })

  it.each(['https://api.deepseek.com', 'http://192.168.1.20:8787', 'not a url'])('rejects %s', (url) => {
    expect(isLoopbackBaseURL(url)).toBe(false)
  })
})

describe('pluginRegistryPath', () => {
  it('keeps the plugin registry out of ~/.raincode', () => {
    expect(pluginRegistryPath()).toMatch(/raincode-dsh[\\/]profiles\.toml$/)
  })
})

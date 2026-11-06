import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gatewayBin, isLoopbackBaseURL, pluginRegistryPath, writeRegistry } from './gateway.js'

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

describe('writeRegistry', () => {
  it('creates missing parent directories and writes a gateway-readable registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raincode-registry-'))
    const path = join(root, 'nested', 'raincode-dsh', 'profiles.toml')
    try {
      await writeRegistry(path, [
        {
          id: 'deepseek-chat',
          name: 'deepseek-chat',
          kind: 'openai-compat',
          baseURL: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          role: 'main',
        },
      ])
      const text = await readFile(path, 'utf8')
      expect(text).toContain('[[profiles]]')
      expect(text).toContain('id = "deepseek-chat"')
      expect(text).toContain('model = "deepseek-chat"')
      expect(text).toContain('active_id = "deepseek-chat"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes a valid empty registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raincode-registry-'))
    const path = join(root, 'profiles.toml')
    try {
      await writeRegistry(path, [])
      expect(await readFile(path, 'utf8')).toContain('profiles = []')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from 'bun:test'
import { checkPublicUrl, isPrivateAddress } from '../../src/util/public-address'

describe('isPrivateAddress', () => {
  test('flags loopback, private, CGNAT, link-local, and reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.72.209',
      '100.64.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
  })

  test('passes public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1']) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })

  test('flags IPv6 loopback, unique-local, link-local, and mapped private v4', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
  })

  test('passes public IPv6 and mapped public v4', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })

  test('treats a non-IP as private', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true)
  })
})

describe('checkPublicUrl', () => {
  test('refuses private IP literals, including ones the URL parser rewrites', async () => {
    expect(await checkPublicUrl('http://127.0.0.1:8080/')).toContain('private')
    expect(await checkPublicUrl('http://2130706433/')).toContain('private')
    expect(await checkPublicUrl('http://[::1]/')).toContain('private')
    expect(await checkPublicUrl('http://[::ffff:127.0.0.1]/')).toContain('private')
  })

  test('refuses hostnames that resolve to loopback', async () => {
    expect(await checkPublicUrl('http://localhost:8080/')).toContain('private')
  })

  test('passes a public IP literal', async () => {
    expect(await checkPublicUrl('https://1.1.1.1/')).toBeUndefined()
  })

  test('reports an unparseable URL', async () => {
    expect(await checkPublicUrl('http://')).toContain('Invalid URL')
  })
})

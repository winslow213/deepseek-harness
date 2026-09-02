import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeProfileError, readNodeProfile } from '@deepseek-ai/dsh-agent-presets'

/** One fresh preset directory holding `profile` as its profile.yml. */
async function profiled(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-'))
  await mkdir(join(root, 'preset'))
  await writeFile(join(root, 'preset', 'profile.yml'), body)
  return join(root, 'preset')
}

describe('readNodeProfile', () => {
  it('treats an absent profile.yml as no profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-absent-'))

    await expect(readNodeProfile(root)).resolves.toEqual({})
  })

  it('parses a persona-only profile', async () => {
    const directory = await profiled('persona: 你是审查员\n')

    await expect(readNodeProfile(directory)).resolves.toEqual({ profile: { persona: '你是审查员' } })
  })

  it('trims a persona and drops a blank one', async () => {
    const directory = await profiled('persona: "  padded  "\n')

    await expect(readNodeProfile(directory)).resolves.toEqual({ profile: { persona: 'padded' } })

    const blank = await profiled('persona: "   "\n')
    // A blank persona alone is still no profile: it must not resolve empty-handed.
    await expect(readNodeProfile(blank)).resolves.toEqual({
      problem: 'the profile file profile.yml must declare a "persona" or a "tools" entry',
    })
  })

  it('parses an allow-only tools filter', async () => {
    const directory = await profiled('tools:\n  allow:\n    - bash\n')

    await expect(readNodeProfile(directory)).resolves.toEqual({ profile: { toolFilter: { allow: ['bash'] } } })
  })

  it('parses a deny-only tools filter', async () => {
    const directory = await profiled('tools:\n  deny:\n    - shell\n')

    await expect(readNodeProfile(directory)).resolves.toEqual({ profile: { toolFilter: { deny: ['shell'] } } })
  })

  it('parses a persona plus both tools sides', async () => {
    const directory = await profiled('persona: 你是审查员\ntools:\n  allow:\n    - bash\n  deny:\n    - shell\n')

    await expect(readNodeProfile(directory)).resolves.toEqual({
      profile: {
        persona: '你是审查员',
        toolFilter: { allow: ['bash'], deny: ['shell'] },
      },
    })
  })

  it('reports unparsable YAML as a profile problem', async () => {
    const directory = await profiled('persona: [unclosed\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /not valid YAML/ })
  })

  it('reports a profile file that is not a map', async () => {
    const directory = await profiled('- just\n- a\n- list\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /must be a map/ })
  })

  it('reports a non-object tools entry', async () => {
    const directory = await profiled('tools: 5\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /invalid "tools" entry: "tools" must be an object/ })
  })

  it('reports tools with no named side', async () => {
    const directory = await profiled('tools: {}\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /must name at least one tool/ })
  })

  it('reports a non-array allow side', async () => {
    const directory = await profiled('tools:\n  allow: bash\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /"tools.allow" must be an array of tool names/ })
  })

  it('reports an allow side holding a non-string', async () => {
    const directory = await profiled('tools:\n  allow:\n    - 42\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /"tools.allow" must be an array of tool names/ })
  })

  it('reports a non-array deny side', async () => {
    const directory = await profiled('tools:\n  deny: shell\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /"tools.deny" must be an array of tool names/ })
  })

  it('reports a deny side holding a non-string', async () => {
    const directory = await profiled('tools:\n  deny:\n    - 42\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /"tools.deny" must be an array of tool names/ })
  })

  it('reports a non-string persona', async () => {
    const directory = await profiled('persona: 7\n')

    await expect(readNodeProfile(directory)).resolves.toMatchObject({ problem: /must declare a "persona" or a "tools" entry/ })
  })
})

describe('NodeProfileError', () => {
  it('carries the preset id and reason in its message', () => {
    const error = new NodeProfileError('auditor', 'profile.yml must be a map')

    expect(error.name).toBe('NodeProfileError')
    expect(error.presetId).toBe('auditor')
    expect(error.message).toContain('"auditor"')
    expect(error.message).toContain('profile.yml must be a map')
  })
})

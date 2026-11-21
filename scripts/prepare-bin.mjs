#!/usr/bin/env node
/**
 * Stages the release binary at bin/sirgit for `pnpm pack` / global install.
 * Wired as both `prepack` (tarball/publish) and `prepare` (dir & git
 * installs), so every packaging path ships the freshly built binary.
 *
 * The npm package IS the binary — no node shim, no runtime deps: pnpm
 * symlinks `sirgit` straight at the Mach-O executable.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

execSync('cargo build --release --manifest-path server/Cargo.toml', {
  cwd: root,
  stdio: 'inherit',
})

const dest = path.join(root, 'bin', 'sirgit')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.copyFileSync(path.join(root, 'server/target/release/sirgit'), dest)
fs.chmodSync(dest, 0o755)

const mb = (fs.statSync(dest).size / 1e6).toFixed(1)
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const cargoToml = path.join(root, 'server/Cargo.toml')
const cargoVersion = fs.readFileSync(cargoToml, 'utf8').match(/^version = "(.+)"/m)?.[1]
if (cargoVersion !== pkgVersion) {
  // package.json is the single version source (release-please bumps it);
  // sync the binary's --version to match before the release build
  fs.writeFileSync(
    cargoToml,
    fs.readFileSync(cargoToml, 'utf8').replace(/^version = ".*"/m, `version = "${pkgVersion}"`),
  )
  console.log(`synced server/Cargo.toml version ${cargoVersion} -> ${pkgVersion}`)
}
console.log(`staged bin/sirgit (${mb} MB) — version ${pkgVersion}`)

#!/usr/bin/env node
// Creates the first FUSION administrator (or another admin) — run once per club.
//
//   npm run setup:admin
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, read from the environment
// or from a local `.env.admin` file. The service-role key is used only here,
// on the owner's machine; it is never bundled into the desktop app. Delete
// `.env.admin` (or the variables) when you are done.
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { argv, stdin, stdout, exit, env } from 'node:process'
import { createClient } from '@supabase/supabase-js'

// Must match AUTH_EMAIL_DOMAIN in src/shared/constants.ts and the Edge Function.
const AUTH_EMAIL_DOMAIN = 'fusion.local'
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/

function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true })
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s)
        else if (s !== '\r\n' && s !== '\n') rl.output.write('*')
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

loadEnvFile('.env.admin')
const url = env.SUPABASE_URL
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (environment or .env.admin). See README → Setup.')
  exit(1)
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

// Recovery: `npm run reset:password` sets a new password for an existing
// account (for example the only administrator, who has no one to reset it
// for them). Only someone holding the project's secret key can do this.
if (argv.includes('--reset-password')) {
  const username = (await ask('Username to reset: ')).toLowerCase()
  const { data: profile, error } = await supabase.from('app_users').select('id, full_name, role').eq('username', username).maybeSingle()
  if (error || !profile) {
    console.error(error ? `Could not read app_users: ${error.message}` : `No FUSION account is called "${username}".`)
    exit(1)
  }
  const password = await ask(`New password for ${profile.full_name} (${profile.role}, 8–72 characters): `, { hidden: true })
  const confirm = await ask('Repeat password: ', { hidden: true })
  if (password.length < 8 || password.length > 72) {
    console.error('The password must be 8–72 characters.')
    exit(1)
  }
  if (password !== confirm) {
    console.error('The passwords do not match.')
    exit(1)
  }
  const { error: updateError } = await supabase.auth.admin.updateUserById(profile.id, { password })
  if (updateError) {
    console.error(`Could not set the password: ${updateError.message}`)
    exit(1)
  }
  console.log(`\nNew password set for "${username}". Remember to delete .env.admin.`)
  exit(0)
}

const { data: existing, error: listError } = await supabase.from('app_users').select('id').eq('role', 'admin').eq('is_active', true)
if (listError) {
  console.error(`Could not read app_users: ${listError.message}\nHave the migrations been applied?`)
  exit(1)
}
if (existing.length > 0) {
  console.log(`Note: ${existing.length} active administrator(s) already exist. This will add another one.`)
}

const username = (await ask('Admin username (e.g. owner): ')).toLowerCase()
if (!USERNAME_RE.test(username)) {
  console.error('Usernames use 3–32 lowercase letters, digits, dots, dashes or underscores.')
  exit(1)
}
const fullName = await ask('Full name: ')
if (!fullName || fullName.length > 80) {
  console.error('A name (up to 80 characters) is required.')
  exit(1)
}
const password = await ask('Admin master password (min 8 characters): ', { hidden: true })
const confirm = await ask('Repeat password: ', { hidden: true })
if (password.length < 8 || password.length > 72) {
  console.error('The password must be 8–72 characters.')
  exit(1)
}
if (password !== confirm) {
  console.error('The passwords do not match.')
  exit(1)
}

const { data: created, error: createError } = await supabase.auth.admin.createUser({
  email: `${username}@${AUTH_EMAIL_DOMAIN}`,
  password,
  email_confirm: true,
  user_metadata: { full_name: fullName, username }
})
if (createError || !created?.user) {
  console.error(`Could not create the login: ${createError?.message ?? 'unknown error'}`)
  exit(1)
}

const { error: profileError } = await supabase
  .from('app_users')
  .insert({ id: created.user.id, username, full_name: fullName, role: 'admin', permissions: [] })
if (profileError) {
  await supabase.auth.admin.deleteUser(created.user.id)
  console.error(`Could not create the admin profile (login removed again): ${profileError.message}`)
  exit(1)
}

console.log(`\nAdministrator "${username}" created. Sign in to FUSION with this username and password.`)
console.log('Remember to delete .env.admin — the service-role key must not stay on POS terminals.')

import { describe, expect, it } from 'vitest'
import { removeAccount, sortAccounts, upsertAccount, withSession, type StoredAccount } from '../../src/renderer/src/lib/accounts'

const account = (userId: string, usedAt: number, refresh = `r-${userId}`): StoredAccount => ({
  userId,
  username: userId,
  fullName: userId.toUpperCase(),
  role: userId === 'owner' ? 'admin' : 'staff',
  floorName: null,
  avatarPath: null,
  session: { access_token: `a-${userId}`, refresh_token: refresh },
  usedAt
})

describe('accounts on this device', () => {
  it('keeps the most recently used first', () => {
    expect(sortAccounts([account('ali', 1), account('owner', 3), account('sara', 2)]).map((a) => a.userId)).toEqual(['owner', 'sara', 'ali'])
  })

  it('adds an account, or replaces the same account signing in again — never two entries for one account', () => {
    let list = upsertAccount([], account('owner', 1))
    list = upsertAccount(list, account('ali', 2))
    list = upsertAccount(list, account('owner', 3, 'r-owner-2'))
    expect(list.map((a) => [a.userId, a.session.refresh_token])).toEqual([
      ['owner', 'r-owner-2'],
      ['ali', 'r-ali']
    ])
  })

  it('stores an account’s rotated tokens without moving it or touching the others', () => {
    const list = withSession([account('owner', 2), account('ali', 1)], 'ali', { access_token: 'a2', refresh_token: 'r2' })
    expect(list.map((a) => [a.userId, a.session.refresh_token])).toEqual([
      ['owner', 'r-owner'],
      ['ali', 'r2']
    ])
    expect(withSession(list, 'nobody', { access_token: 'x', refresh_token: 'y' })).toEqual(list)
  })

  it('removes one account, keeping the rest', () => {
    expect(removeAccount([account('owner', 2), account('ali', 1)], 'owner').map((a) => a.userId)).toEqual(['ali'])
  })
})

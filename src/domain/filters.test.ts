import { describe, expect, it } from 'vitest'
import { attentionFor } from './attention'
import { DEFAULT_FILTERS, matchesFilters } from './filters'
import { deal, NOW } from '../test/fixtures'

const row = { deal, searchName: deal.companyName.toLowerCase(), attention: attentionFor(deal, NOW) }

describe('shared pipeline membership', () => {
  it('combines view, search, owner, and stage with AND semantics', () => {
    expect(matchesFilters(row, { view: 'mine', search: '  ATLAS  ', ownerId: 'owner-1', stage: 'new-lead' })).toBe(true)
    expect(matchesFilters(row, { ...DEFAULT_FILTERS, stage: 'won' })).toBe(false)
    expect(matchesFilters(row, { ...DEFAULT_FILTERS, ownerId: 'owner-2' })).toBe(false)
    expect(matchesFilters(row, { ...DEFAULT_FILTERS, search: 'missing company' })).toBe(false)
    expect(matchesFilters(row, { ...DEFAULT_FILTERS, view: 'mine' }, 'owner-2')).toBe(false)
  })

  it('excludes unflagged deals from attention, while treating an empty or whitespace search as no restriction', () => {
    expect(matchesFilters({ ...row, attention: null }, { ...DEFAULT_FILTERS, view: 'attention' })).toBe(false)
    expect(matchesFilters(row, { ...DEFAULT_FILTERS, search: '  ' })).toBe(true)
  })
})

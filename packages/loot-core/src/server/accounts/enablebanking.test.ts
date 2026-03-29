import {
  assertSessionIsActive,
  EnableBankingClient,
  normalizeEnableBankingTransaction,
  pickBookedBalance,
  syncEnableBankingTransactions,
} from './enablebanking';

function makeJsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EnableBankingClient auth flow', () => {
  it('handles happy path auth flow', async () => {
    const requester = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({ aspsps: [{ id: 'bank-1' }] }))
      .mockResolvedValueOnce(
        makeJsonResponse({
          url: 'https://tilisy.enablebanking.com/redirect',
          authorization_id: 'auth-1',
          psu_id_hash: 'psu-1',
        }),
      );

    const client = new EnableBankingClient({
      baseUrl: 'https://api.enablebanking.com',
      jwt: 'jwt',
      requester,
    });

    const aspsps = await client.getAspsps();
    const authorization = await client.startAuthorization({
      aspsp: { id: 'bank-1' },
      redirectUrl: 'https://app/callback',
      state: 'state-1',
    });

    expect(aspsps.aspsps).toEqual([{ id: 'bank-1' }]);
    expect(authorization.authorization_id).toBe('auth-1');
    expect(authorization.url).toContain('tilisy.enablebanking.com');
  });

  it('handles callback with valid code', async () => {
    const client = new EnableBankingClient({
      baseUrl: 'https://api.enablebanking.com',
      jwt: 'jwt',
      requester: vi.fn().mockResolvedValue(
        makeJsonResponse({
          session_id: 'session-1',
          status: 'AUTHORIZED',
          access: { valid_until: '2026-12-31' },
        }),
      ),
    });

    expect(() =>
      client.validateCallback({ state: 'ok', expectedState: 'ok' }),
    ).not.toThrow();

    const session = await client.exchangeCodeForSession('code-1');
    expect(session.session_id).toBe('session-1');
  });

  it('handles callback with error', () => {
    const client = new EnableBankingClient({
      baseUrl: 'https://api.enablebanking.com',
      jwt: 'jwt',
      requester: vi.fn(),
    });

    expect(() =>
      client.validateCallback({
        state: 'ok',
        expectedState: 'ok',
        error: 'access_denied',
      }),
    ).toThrow(/access_denied/);
  });

  it('rejects callback state mismatch', () => {
    const client = new EnableBankingClient({
      baseUrl: 'https://api.enablebanking.com',
      jwt: 'jwt',
      requester: vi.fn(),
    });

    expect(() =>
      client.validateCallback({ state: 'one', expectedState: 'two' }),
    ).toThrow(/state mismatch/);
  });
});

describe('Enable Banking session lifecycle', () => {
  it('detects expired session', () => {
    expect(() =>
      assertSessionIsActive({ session_id: 's1', status: 'EXPIRED' }),
    ).toThrow(/EXPIRED/);
  });
});

describe('Enable Banking pagination', () => {
  it('paginates across multiple pages', async () => {
    const getTransactions = vi
      .fn()
      .mockResolvedValueOnce({
        transactions: [
          {
            entry_reference: 't1',
            booking_date: '2026-01-01',
            transaction_amount: { amount: '-10' },
            debtor: { name: 'Coffee' },
          },
        ],
        continuation_key: 'next-page',
      })
      .mockResolvedValueOnce({
        transactions: [
          {
            entry_reference: 't2',
            booking_date: '2026-01-02',
            transaction_amount: { amount: '-20' },
            debtor: { name: 'Lunch' },
          },
        ],
      });

    const data = await syncEnableBankingTransactions(
      { getTransactions },
      'acct-1',
      '2026-01-01',
    );

    expect(getTransactions).toHaveBeenCalledTimes(2);
    expect(data.map(t => t.imported_id)).toEqual(['t1', 't2']);
  });
});

describe('Enable Banking normalization', () => {
  it('creates fallback ID when identifiers are missing', () => {
    const tx = normalizeEnableBankingTransaction('acct-1', {
      booking_date: '2026-01-03',
      transaction_amount: { amount: '-9.99' },
      debtor: { name: 'Store' },
    });

    expect(tx.imported_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('dedupes duplicate transaction IDs', async () => {
    const getTransactions = vi.fn().mockResolvedValue({
      transactions: [
        {
          entry_reference: 'dup',
          booking_date: '2026-01-03',
          transaction_amount: { amount: '-9.99' },
          debtor: { name: 'Store' },
        },
        {
          entry_reference: 'dup',
          booking_date: '2026-01-03',
          transaction_amount: { amount: '-9.99' },
          debtor: { name: 'Store' },
        },
      ],
    });

    const data = await syncEnableBankingTransactions(
      { getTransactions },
      'acct-1',
      '2026-01-01',
    );

    expect(data).toHaveLength(1);
  });

  it('supports empty transaction list', async () => {
    const getTransactions = vi
      .fn()
      .mockResolvedValue({ transactions: [], continuation_key: undefined });

    const data = await syncEnableBankingTransactions(
      { getTransactions },
      'acct-1',
      '2026-01-01',
    );

    expect(data).toEqual([]);
  });

  it('handles balance missing', () => {
    expect(pickBookedBalance([])).toBe(null);
  });

  it('handles partial data responses', () => {
    const tx = normalizeEnableBankingTransaction('acct-1', {
      value_date: '2026-01-04',
      transaction_amount: { amount: '14.00' },
    });

    expect(tx.date).toBe('2026-01-04');
    expect(tx.payee).toBe('Unknown');
  });
});

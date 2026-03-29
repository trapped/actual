import { createHash } from 'node:crypto';

import { fetch } from '../../platform/server/fetch';
import { logger } from '../../platform/server/log';

type EnableBankingRequester = typeof fetch;

type Json = Record<string, unknown>;

export type EnableBankingAspsp = {
  id: string;
  name?: string;
  countries?: string[];
  auth_methods?: string[];
  max_access_valid_for_days?: number;
};

export type EnableBankingAccess = {
  valid_until?: string;
};

export type EnableBankingSessionState =
  | 'AUTHORIZED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'CANCELLED'
  | string;

export type EnableBankingSession = {
  session_id: string;
  status?: EnableBankingSessionState;
  accounts?: Array<{ uid: string; identification_hash?: string }>;
  accounts_data?: Array<{ id?: string; identification_hash?: string }>;
  aspsp?: Json;
  access?: EnableBankingAccess;
};

export type EnableBankingTransaction = {
  entry_reference?: string;
  transaction_id?: string;
  internal_transaction_id?: string;
  booking_date?: string;
  value_date?: string;
  transaction_amount?: {
    amount?: string;
    currency?: string;
  };
  creditor?: { name?: string };
  debtor?: { name?: string };
  remittance_information_unstructured?: string;
  remittance_information_structured?: string;
};

export type NormalizedEnableBankingTransaction = {
  amount: string;
  date: string;
  payee: string;
  notes: string | null;
  imported_id: string;
  raw_synced_data: string;
};

export type EnableBankingClientConfig = {
  baseUrl: string;
  jwt: string;
  requester?: EnableBankingRequester;
};

export type StartAuthorizationParams = {
  aspsp: Json;
  redirectUrl: string;
  state: string;
};

export type GetTransactionsParams = {
  from?: string;
  to?: string;
  continuationKey?: string;
  transactionStatus?: 'booked' | 'pending';
};

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Enable Banking API error (${response.status}): ${text}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

function requireDate(
  transaction: EnableBankingTransaction,
): string {
  const date = transaction.booking_date ?? transaction.value_date;
  if (!date) {
    throw new Error('Enable Banking transaction is missing booking_date/value_date');
  }
  return date;
}

function getPayee(transaction: EnableBankingTransaction): string {
  return (
    transaction.creditor?.name ??
    transaction.debtor?.name ??
    transaction.remittance_information_unstructured ??
    transaction.remittance_information_structured ??
    'Unknown'
  );
}

function makeFallbackId(
  accountId: string,
  transaction: EnableBankingTransaction,
  date: string,
  payee: string,
): string {
  const amount = transaction.transaction_amount?.amount ?? '0';
  const input = `${accountId}|${date}|${amount}|${payee}`;
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeEnableBankingTransaction(
  accountId: string,
  transaction: EnableBankingTransaction,
): NormalizedEnableBankingTransaction {
  const date = requireDate(transaction);
  const payee = getPayee(transaction);
  const imported_id =
    transaction.entry_reference ??
    transaction.transaction_id ??
    transaction.internal_transaction_id ??
    makeFallbackId(accountId, transaction, date, payee);

  return {
    amount: transaction.transaction_amount?.amount ?? '0',
    date,
    payee,
    notes:
      transaction.remittance_information_unstructured ??
      transaction.remittance_information_structured ??
      null,
    imported_id,
    raw_synced_data: JSON.stringify(transaction),
  };
}

export function pickBookedBalance(
  balances: Array<{
    balance_type?: string;
    balance_amount?: { amount?: string; currency?: string };
  }>,
) {
  if (!balances.length) {
    return null;
  }

  const booked =
    balances.find(balance => balance.balance_type === 'CLBD') ??
    balances.find(balance => balance.balance_type === 'CLAV');

  return booked ?? balances[0];
}

export class EnableBankingClient {
  private readonly baseUrl: string;
  private readonly jwt: string;
  private readonly requester: EnableBankingRequester;

  constructor(config: EnableBankingClientConfig) {
    this.baseUrl = config.baseUrl;
    this.jwt = config.jwt;
    this.requester = config.requester ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.requester(joinUrl(this.baseUrl, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    return parseResponse<T>(response);
  }

  getAspsps(params?: { country?: string; psu_type?: string }) {
    const search = new URLSearchParams();
    if (params?.country) search.set('country', params.country);
    if (params?.psu_type) search.set('psu_type', params.psu_type);
    const query = search.size ? `?${search.toString()}` : '';
    return this.request<{ aspsps: EnableBankingAspsp[] }>(`/aspsps${query}`);
  }

  startAuthorization({ aspsp, redirectUrl, state }: StartAuthorizationParams) {
    return this.request<{
      url: string;
      authorization_id: string;
      psu_id_hash?: string;
    }>('/auth', {
      method: 'POST',
      body: JSON.stringify({
        access: {
          accounts: [],
          balances: true,
          transactions: true,
        },
        aspsp,
        state,
        redirect_url: redirectUrl,
      }),
    });
  }

  validateCallback(params: { state?: string; expectedState: string; error?: string }) {
    if (params.error) {
      throw new Error(`Enable Banking callback error: ${params.error}`);
    }

    if (!params.state || params.state !== params.expectedState) {
      throw new Error('Enable Banking callback state mismatch');
    }
  }

  exchangeCodeForSession(code: string) {
    return this.request<EnableBankingSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  getSession(sessionId: string) {
    return this.request<EnableBankingSession>(`/sessions/${sessionId}`);
  }

  async deleteSession(sessionId: string) {
    await this.request(`/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async getAccounts(sessionId: string) {
    const session = await this.getSession(sessionId);
    return session.accounts ?? [];
  }

  getBalances(accountId: string) {
    return this.request<{
      balances: Array<{
        balance_type?: string;
        balance_amount?: { amount?: string; currency?: string };
      }>;
    }>(`/accounts/${accountId}/balances`);
  }

  getTransactions(accountId: string, params: GetTransactionsParams = {}) {
    const search = new URLSearchParams();
    if (params.from) search.set('date_from', params.from);
    if (params.to) search.set('date_to', params.to);
    if (params.continuationKey) {
      search.set('continuation_key', params.continuationKey);
    }
    if (params.transactionStatus) {
      search.set('transaction_status', params.transactionStatus);
    }

    const query = search.size ? `?${search.toString()}` : '';
    return this.request<{
      transactions: EnableBankingTransaction[];
      continuation_key?: string;
    }>(`/accounts/${accountId}/transactions${query}`);
  }
}

export async function syncEnableBankingTransactions(
  client: Pick<EnableBankingClient, 'getTransactions'>,
  accountId: string,
  from: string,
  to?: string,
) {
  const normalized: NormalizedEnableBankingTransaction[] = [];
  const dedupe = new Set<string>();
  let continuationKey: string | undefined;

  do {
    const page = await client.getTransactions(accountId, {
      from,
      to,
      continuationKey,
      transactionStatus: 'booked',
    });

    for (const transaction of page.transactions ?? []) {
      const mapped = normalizeEnableBankingTransaction(accountId, transaction);
      const dedupeKey = `${mapped.imported_id}|${mapped.date}|${mapped.amount}`;
      if (!dedupe.has(dedupeKey)) {
        dedupe.add(dedupeKey);
        normalized.push(mapped);
      }
    }

    continuationKey = page.continuation_key;
  } while (continuationKey);

  return normalized;
}

export function assertSessionIsActive(session: EnableBankingSession) {
  if (
    session.status === 'EXPIRED' ||
    session.status === 'REVOKED' ||
    session.status === 'CANCELLED'
  ) {
    logger.warn('Enable Banking session is not active', {
      sessionId: session.session_id,
      status: session.status,
    });
    throw new Error(`Enable Banking session ${session.status}`);
  }
}

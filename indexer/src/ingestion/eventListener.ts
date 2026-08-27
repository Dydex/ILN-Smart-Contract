import { humanizeEvents, xdr } from '@stellar/stellar-sdk';
import type { EventRepository, InvoiceRecord, IngestedEventRecord, ReputationUpdateRecord } from '../db/eventRepository.js';

export interface HorizonTransactionRecord {
  hash: string;
  ledger: number;
  created_at: string;
  paging_token: string;
  result_meta_xdr: string;
}

export interface DecodedContractEvent {
  contractId: string | null;
  rawEventType: string;
  contractEventType: string;
  topics: unknown[];
  data: unknown;
}

export interface EventListenerOptions {
  repository: EventRepository;
  horizonUrl: string;
  contractAddress: string;
  fetchImpl?: typeof fetch;
  decodeTransactionEvents?: (record: HorizonTransactionRecord) => DecodedContractEvent[];
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const LAST_CURSOR_STATE_KEY = 'last_processed_cursor';
const LAST_LEDGER_STATE_KEY = 'last_processed_ledger';

export class EventListener {
  private readonly repository: EventRepository;
  private readonly horizonUrl: string;
  private readonly contractAddress: string;
  private readonly fetchImpl: typeof fetch;
  private readonly decodeTransactionEvents: (record: HorizonTransactionRecord) => DecodedContractEvent[];
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private stopped = false;
  private activeAbortController: AbortController | null = null;

  constructor(options: EventListenerOptions) {
    this.repository = options.repository;
    this.horizonUrl = options.horizonUrl.replace(/\/$/, '');
    this.contractAddress = options.contractAddress;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.decodeTransactionEvents = options.decodeTransactionEvents ?? decodeTransactionEventsFromMeta;
    this.logger = options.logger ?? console;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  stop(): void {
    this.stopped = true;
    this.activeAbortController?.abort();
  }

  async start(): Promise<void> {
    let backoffMs = this.initialBackoffMs;
    let cursor = this.repository.getState(LAST_CURSOR_STATE_KEY) || 'now';

    while (!this.stopped) {
      const controller = new AbortController();
      this.activeAbortController = controller;

      try {
        this.logger.info(`indexer ingestion connected to Horizon transactions stream at cursor ${cursor}`);
        await this.consumeStream(cursor, controller.signal);
        backoffMs = this.initialBackoffMs;
        cursor = this.repository.getState(LAST_CURSOR_STATE_KEY) || cursor;
      } catch (error) {
        if (this.stopped) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`indexer ingestion stream error: ${message}`);
        await delay(backoffMs, controller.signal).catch(() => undefined);
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        cursor = this.repository.getState(LAST_CURSOR_STATE_KEY) || cursor;
      } finally {
        if (this.activeAbortController === controller) {
          this.activeAbortController = null;
        }
      }
    }
  }

  private async consumeStream(cursor: string, signal: AbortSignal): Promise<void> {
    const url = new URL('/transactions', this.horizonUrl);
    url.searchParams.set('cursor', cursor);
    url.searchParams.set('order', 'asc');
    url.searchParams.set('limit', '200');

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'text/event-stream',
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Horizon responded with HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('Horizon stream did not include a response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!this.stopped) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await this.handleSseChunk(chunk);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  private async handleSseChunk(chunk: string): Promise<void> {
    const lines = chunk.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      return;
    }

    const rawPayload = dataLines.join('\n');
    if (!rawPayload || rawPayload === '[DONE]') {
      return;
    }

    const record = JSON.parse(rawPayload) as HorizonTransactionRecord;
    await this.processTransaction(record);
  }

  /**
   * Decode, persist, and checkpoint a single Horizon transaction record.
   * Public so the replay runner can re-process historical transactions with
   * identical semantics to live ingestion (idempotent upserts).
   */
  async processTransaction(record: HorizonTransactionRecord): Promise<void> {
    let processedSuccessfully = false;

    try {
      const decodedEvents = this.decodeTransactionEvents(record).filter(
        (event) => event.contractId === this.contractAddress
      );

      for (let index = 0; index < decodedEvents.length; index += 1) {
        const event = decodedEvents[index];
        const payload = toRecordPayload(normalizeJsonValue(event.data));
        const invoiceId = coerceNullableNumber(payload.invoice_id);
        const existingInvoice = invoiceId === null ? undefined : this.repository.getInvoice(invoiceId);
        const processed = normalizeProcessedEvent(event, record, index, existingInvoice, payload);

        // Upsert the parent invoice row BEFORE the child event row so the
        // events.invoice_id -> invoices(id) foreign key holds when foreign
        // keys are enforced (production enables them via getDb()).
        if (processed.invoiceRow) {
          this.repository.upsertInvoice(processed.invoiceRow);
        }

        if (processed.reputationUpdateRow) {
          this.repository.insertReputationUpdate(processed.reputationUpdateRow);
        }

        this.repository.insertEvent(processed.rawEvent);

        this.logger.info(
          `processed ${processed.rawEvent.contract_event_type ?? processed.rawEvent.event_type} at ledger ${processed.rawEvent.ledger} (tx ${record.hash})`
        );
      }

      processedSuccessfully = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`failed to process transaction ${record.hash}: ${message}`);
    }

    if (processedSuccessfully) {
      this.repository.setState(LAST_CURSOR_STATE_KEY, record.paging_token);
      this.repository.setState(LAST_LEDGER_STATE_KEY, String(record.ledger));
    }
  }
}

export function createEventListener(options: EventListenerOptions): EventListener {
  return new EventListener(options);
}

export function decodeTransactionEventsFromMeta(
  record: HorizonTransactionRecord
): DecodedContractEvent[] {
  const meta = xdr.TransactionMeta.fromXDR(record.result_meta_xdr, 'base64');
  const contractEvents = extractContractEvents(meta);
  return humanizeEvents(contractEvents as any)
    .filter((event) => event.type === 'contract')
    .map((event) => {
      const topics = event.topics ?? [];
      const rawEventType = String(topics[0] ?? '');
      return {
        contractId: event.contractId ?? null,
        rawEventType,
        contractEventType: canonicalEventType(rawEventType),
        topics,
        data: event.data,
      };
    });
}

function extractContractEvents(
  meta: ReturnType<typeof xdr.TransactionMeta.fromXDR>
): Array<xdr.ContractEvent | xdr.TransactionEvent> {
  switch (meta.switch()) {
    case 3: {
      const transactionMeta = meta.value() as xdr.TransactionMetaV3;
      const sorobanMeta = transactionMeta.sorobanMeta();
      return (sorobanMeta?.events() ?? []) as Array<xdr.ContractEvent | xdr.TransactionEvent>;
    }
    case 4: {
      const transactionMeta = meta.value() as xdr.TransactionMetaV4;
      return (transactionMeta.events() ?? []) as Array<xdr.ContractEvent | xdr.TransactionEvent>;
    }
    default:
      return [];
  }
}

function normalizeProcessedEvent(
  event: DecodedContractEvent,
  record: HorizonTransactionRecord,
  eventIndex: number,
  existingInvoice: InvoiceRecord | undefined,
  payload: Record<string, unknown>
): {
  rawEvent: IngestedEventRecord;
  invoiceRow?: InvoiceRecord;
  reputationUpdateRow?: ReputationUpdateRecord;
} {
  const normalizedData = normalizeJsonValue(event.data);
  const topicsJson = JSON.stringify(normalizeJsonValue(event.topics));
  const txTimestamp = parseRecordTimestamp(record);
  const rawEventType = event.rawEventType || inferRawEventType(event.contractEventType);
  const contractEventType = event.contractEventType || canonicalEventType(rawEventType);
  const ledger = record.ledger;
  const common = {
    contract_id: event.contractId,
    contract_event_type: contractEventType,
    transaction_hash: record.hash,
    transaction_paging_token: record.paging_token,
    event_index: eventIndex,
    topics_json: topicsJson,
  };

  switch (contractEventType) {
    case 'InvoiceSubmitted': {
      const invoiceRow: InvoiceRecord = {
        id: coerceNumber(payload.invoice_id),
        freelancer: coerceString(payload.freelancer, existingInvoice?.freelancer ?? ''),
        payer: coerceString(payload.payer, existingInvoice?.payer ?? ''),
        token: coerceString(payload.token, existingInvoice?.token ?? ''),
        amount: coerceString(payload.amount, existingInvoice?.amount ?? '0'),
        due_date: coerceNumber(payload.due_date, existingInvoice?.due_date ?? txTimestamp),
        discount_rate: coerceNumber(payload.discount_rate, existingInvoice?.discount_rate ?? 0),
        status: coerceString(payload.status, existingInvoice?.status ?? 'Pending'),
        funder: existingInvoice?.funder ?? null,
        funded_at: existingInvoice?.funded_at ?? null,
        amount_funded: coerceString(payload.amount_funded, existingInvoice?.amount_funded ?? '0'),
        amount_paid: coerceString(payload.amount_paid, existingInvoice?.amount_paid ?? '0'),
        referral_code: serializeNullableText(payload.referral_code) ?? existingInvoice?.referral_code ?? null,
        submitter_reputation: coerceNumber(payload.submitter_reputation, existingInvoice?.submitter_reputation ?? 0),
        created_at: coerceNumber(payload.timestamp, existingInvoice?.created_at ?? txTimestamp),
      };

      return {
        rawEvent: {
          invoice_id: invoiceRow.id,
          event_type: rawEventType,
          ledger,
          timestamp: invoiceRow.created_at,
          data: JSON.stringify(normalizedData),
          ...common,
        },
        invoiceRow,
      };
    }
    case 'InvoiceFunded': {
      const invoiceRow: InvoiceRecord = {
        id: coerceNumber(payload.invoice_id),
        freelancer: coerceString(payload.freelancer, existingInvoice?.freelancer ?? ''),
        payer: coerceString(payload.payer, existingInvoice?.payer ?? ''),
        token: coerceString(payload.token, existingInvoice?.token ?? ''),
        amount: coerceString(payload.invoice_amount ?? payload.amount, existingInvoice?.amount ?? '0'),
        due_date: coerceNumber(payload.due_date, existingInvoice?.due_date ?? txTimestamp),
        discount_rate: coerceNumber(payload.discount_rate, existingInvoice?.discount_rate ?? 0),
        status: coerceString(payload.status, existingInvoice?.status ?? 'Funded'),
        funder: coerceNullableString(payload.funder ?? payload.lp) ?? existingInvoice?.funder ?? null,
        funded_at: coerceNullableNumber(payload.funded_at, existingInvoice?.funded_at ?? txTimestamp),
        amount_funded: coerceString(payload.amount_funded ?? payload.fund_amount, existingInvoice?.amount_funded ?? '0'),
        amount_paid: existingInvoice?.amount_paid ?? '0',
        referral_code: existingInvoice?.referral_code ?? null,
        submitter_reputation: existingInvoice?.submitter_reputation ?? 0,
        created_at: existingInvoice?.created_at ?? txTimestamp,
      };

      return {
        rawEvent: {
          invoice_id: invoiceRow.id,
          event_type: rawEventType,
          ledger,
          timestamp: coerceNumber(payload.timestamp, txTimestamp),
          data: JSON.stringify(normalizedData),
          ...common,
        },
        invoiceRow,
      };
    }
    case 'InvoicePaid': {
      const invoiceRow: InvoiceRecord = {
        id: coerceNumber(payload.invoice_id),
        freelancer: coerceString(payload.freelancer, existingInvoice?.freelancer ?? ''),
        payer: coerceString(payload.payer, existingInvoice?.payer ?? ''),
        token: coerceString(payload.token, existingInvoice?.token ?? ''),
        amount: coerceString(payload.amount_paid ?? payload.invoice_amount, existingInvoice?.amount ?? '0'),
        due_date: existingInvoice?.due_date ?? txTimestamp,
        discount_rate: existingInvoice?.discount_rate ?? 0,
        status: coerceString(payload.status, existingInvoice?.status ?? 'Paid'),
        funder: coerceNullableString(payload.lp) ?? existingInvoice?.funder ?? null,
        funded_at: existingInvoice?.funded_at ?? null,
        amount_funded: coerceString(payload.lp_payout ?? payload.amount_paid, existingInvoice?.amount_funded ?? '0'),
        amount_paid: coerceString(payload.amount_paid, existingInvoice?.amount_paid ?? '0'),
        referral_code: existingInvoice?.referral_code ?? null,
        submitter_reputation: existingInvoice?.submitter_reputation ?? 0,
        created_at: existingInvoice?.created_at ?? txTimestamp,
      };

      return {
        rawEvent: {
          invoice_id: invoiceRow.id,
          event_type: rawEventType,
          ledger,
          timestamp: coerceNumber(payload.settlement_timestamp, txTimestamp),
          data: JSON.stringify(normalizedData),
          ...common,
        },
        invoiceRow,
      };
    }
    case 'InvoiceCancelled':
    case 'InvoiceExpired':
    case 'InvoiceDisputed': {
      const invoiceRow: InvoiceRecord = {
        id: coerceNumber(payload.invoice_id),
        freelancer: coerceString(payload.freelancer, existingInvoice?.freelancer ?? ''),
        payer: coerceString(payload.payer, existingInvoice?.payer ?? ''),
        token: coerceString(payload.token, existingInvoice?.token ?? ''),
        amount: coerceString(payload.amount, existingInvoice?.amount ?? '0'),
        due_date: coerceNumber(payload.due_date, existingInvoice?.due_date ?? txTimestamp),
        discount_rate: coerceNumber(payload.discount_rate, existingInvoice?.discount_rate ?? 0),
        status: coerceString(payload.status, existingInvoice?.status ?? contractEventType.replace(/^Invoice/, '')),
        funder: coerceNullableString(payload.funder) ?? existingInvoice?.funder ?? null,
        funded_at: coerceNullableNumber(payload.funded_at, existingInvoice?.funded_at ?? null),
        amount_funded: coerceString(payload.amount_funded, existingInvoice?.amount_funded ?? '0'),
        amount_paid: coerceString(payload.amount_paid, existingInvoice?.amount_paid ?? '0'),
        referral_code: existingInvoice?.referral_code ?? null,
        submitter_reputation: existingInvoice?.submitter_reputation ?? 0,
        created_at: existingInvoice?.created_at ?? txTimestamp,
      };

      return {
        rawEvent: {
          invoice_id: invoiceRow.id,
          event_type: rawEventType,
          ledger,
          timestamp: coerceNumber(payload.timestamp ?? payload.disputed_at ?? payload.defaulted_at, txTimestamp),
          data: JSON.stringify(normalizedData),
          ...common,
        },
        invoiceRow,
      };
    }
    case 'ReputationUpdated': {
      const reputationUpdateRow: ReputationUpdateRecord = {
        address: coerceString(payload.address),
        event_type: rawEventType,
        old_score: coerceNumber(payload.old_score, 0),
        new_score: coerceNumber(payload.new_score, 0),
        invoices_submitted: coerceNumber(payload.invoices_submitted, 0),
        invoices_paid: coerceNumber(payload.invoices_paid, 0),
        invoices_defaulted: coerceNumber(payload.invoices_defaulted, 0),
        ledger,
        timestamp: txTimestamp,
        contract_id: event.contractId,
        transaction_hash: record.hash,
        transaction_paging_token: record.paging_token,
        event_index: eventIndex,
        topics_json: topicsJson,
      };

      return {
        rawEvent: {
          invoice_id: null,
          event_type: rawEventType,
          ledger,
          timestamp: txTimestamp,
          data: JSON.stringify(normalizedData),
          ...common,
        },
        reputationUpdateRow,
      };
    }
    default: {
      return {
        rawEvent: {
          invoice_id: coerceNullableNumber(payload.invoice_id),
          event_type: rawEventType,
          ledger,
          timestamp: coerceNumber(payload.timestamp, txTimestamp),
          data: JSON.stringify(normalizedData),
          ...common,
        },
      };
    }
  }
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeJsonValue(entry),
      ])
    );
  }

  return value;
}

function toRecordPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function coerceString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return fallback;
}

function coerceNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = coerceString(value, '');
  return text.length > 0 ? text : null;
}

function coerceNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function coerceNullableNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) {
    return fallback;
  }

  return coerceNumber(value, fallback ?? 0);
}

function serializeNullableText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    return JSON.stringify(normalizeJsonValue(value));
  }

  return String(value);
}

function parseRecordTimestamp(record: HorizonTransactionRecord): number {
  const parsed = Date.parse(record.created_at);
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed / 1000);
  }

  return record.ledger;
}

function canonicalEventType(rawEventType: string): string {
  const normalized = rawEventType.trim();

  switch (normalized) {
    case 'submitted':
      return 'InvoiceSubmitted';
    case 'updated':
      return 'InvoiceUpdated';
    case 'funded':
      return 'InvoiceFunded';
    case 'paid':
      return 'InvoicePaid';
    case 'partially_paid':
      return 'InvoicePartiallyPaid';
    case 'transferred':
      return 'InvoiceTransferred';
    case 'lp_position_transferred':
      return 'LPPositionTransferred';
    case 'cancelled':
      return 'InvoiceCancelled';
    case 'defaulted':
      return 'InvoiceDefaulted';
    case 'disputed':
      return 'InvoiceDisputed';
    case 'expired':
      return 'InvoiceExpired';
    case 'reputation_updated':
      return 'ReputationUpdated';
    case 'paused':
      return 'ContractPaused';
    case 'unpaused':
      return 'ContractUnpaused';
    case 'admin_changed':
      return 'AdminChanged';
    case 'parameter_updated':
      return 'ParameterUpdated';
    case 'contract_upgraded':
      return 'ContractUpgraded';
    default:
      return normalized
        .split('_')
        .map((part) => {
          if (part.toLowerCase() === 'lp') {
            return 'LP';
          }
          return part ? part[0].toUpperCase() + part.slice(1) : '';
        })
        .join('');
  }
}

function inferRawEventType(contractEventType: string): string {
  const mapping: Record<string, string> = {
    InvoiceSubmitted: 'submitted',
    InvoiceUpdated: 'updated',
    InvoiceFunded: 'funded',
    InvoicePaid: 'paid',
    InvoicePartiallyPaid: 'partially_paid',
    InvoiceTransferred: 'transferred',
    LPPositionTransferred: 'lp_position_transferred',
    InvoiceCancelled: 'cancelled',
    InvoiceDefaulted: 'defaulted',
    InvoiceDisputed: 'disputed',
    InvoiceExpired: 'expired',
    ReputationUpdated: 'reputation_updated',
    ContractPaused: 'paused',
    ContractUnpaused: 'unpaused',
    AdminChanged: 'admin_changed',
    ParameterUpdated: 'parameter_updated',
    ContractUpgraded: 'contract_upgraded',
  };

  return mapping[contractEventType] ?? contractEventType.toLowerCase();
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('aborted'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

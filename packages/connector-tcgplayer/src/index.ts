/**
 * @hub/connector-tcgplayer — TCGPlayer as a file-based channel.
 *
 * TCGPlayer closed its developer programme to new applicants, so there is no
 * API to call and no credentials to obtain (ADR 0002). The connector instead
 * renders a `MyPricing`-shaped CSV for the operator to upload to TCGPlayer Pro,
 * and ingests the `MyPricing` and `PullSheet` exports they download back.
 *
 * Built and verified against redacted fixtures of real exports in
 * `test/fixtures/`, never against a live account.
 */

export {
  TCGPLAYER_CONNECTOR_KEY,
  createTcgPlayerConnector,
  formatMoney,
  parseOrderQuantity,
  saleKey,
  type OrderQuantityPair,
} from './tcgplayer';

export {
  LANGUAGE_NAMES,
  TCG_CONDITIONS,
  TCG_EDITIONS,
  TCG_FINISHES,
  formatCondition,
  fromPrinting,
  parseCondition,
  toPrinting,
  type ConditionFormat,
  type ConditionParse,
  type SplitCondition,
  type TcgCondition,
  type TcgEdition,
  type TcgFinish,
} from './condition';

export { MY_PRICING, PULL_SHEET, type FileFormat } from './formats';

export { parseCsv, parseMoneyToCents, parseQuantity, toCsv, type CsvTable } from './csv';

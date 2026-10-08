// The supported entry point of @alcove/core: the names a consumer of the
// published package may import from "@alcove/core". They are listed one at a
// time rather than re-exported by module, so publishing a name is a decision
// made here rather than a side effect of exporting it somewhere under src/.
//
// A name belongs here when production code outside packages/core calls it, or
// when a comment beside it states why the package publishes it anyway.
// Anything else stays module-internal, and product code exposed only so a test
// outside packages/core can drive it goes on the ./testing subpath
// (src/testing.ts). Which channel shared test material takes: docs/TESTING.md,
// Shared test material.

export {
  AcceptedTermsShapeError,
  AuthenticationError,
  ConnectionError,
  DeliveryUnconfirmedError,
  DirectoryListingBoundsError,
  FrameSizeExceededError,
  InternalConsistencyError,
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  PeerAbortError,
  RoundCapacityError,
  RoundSetLimitError,
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  UsageError,
  asConnectionError,
  causeChainSome,
  chainDetailCauses,
  errorMessage,
  isPeerWaitTimeout,
  isSetTooLargeError,
  markStatesItsOwnNextStep,
  statesItsOwnNextStep,
} from "./errors";
export type { ConnectionErrorKind } from "./errors";
export { annotate, annotationKey, annotationOf } from "./failureAnnotation";
export {
  FAILURE_CAUSE_PATH_MAX_LENGTH,
  failureCauseFromUntrusted,
  failureCauseOf,
  failureCauseSentence,
  formatWaitDuration,
  markFailureCause,
  relayRegistrarUnreachableRemedy,
} from "./failureCause";
export type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
  FolderMissingCode,
  RelayRegistrarUnreachableFailure,
} from "./failureCause";
export {
  classifyFailure,
  firstLinkBehindTransportWraps,
  isTrustBoundaryFailure,
} from "./failureClass";
export type { FailureClass } from "./failureClass";
export { ProcessState } from "./psi/participant";
export type {
  PsiOperation,
  PsiProgress,
  PsiProgressReporter,
} from "./psi/participant";
export {
  PSI_SET_REFUSED_ABORT_REASON,
  PSI_SET_TOO_LARGE_ABORT_REASON,
} from "./partnerAbortFrame";
export { loadPsiBackend } from "./psi/psiBackend";
export type { PsiBackendOptions, PsiBackendSelection } from "./psi/psiBackend";
export { InProcessPsiEngine } from "./psi/psiEngine";
export type { PsiEngine, PsiEngineMode } from "./psi/psiEngine";
// Named because published signatures use them: the declaration chunk the entry
// points share can refer only to a type one of them exports.
export type {
  InProcessPsiEngineOptions,
  PsiMatchMethod,
  PsiProcessedElementsReporter,
} from "./psi/psiEngine";
export { psiEngineOptionsForBackend } from "./psi/psiMatchSlices";
export { WorkerPsiEngine, servePsiWorker } from "./psi/psiWorkerEngine";
export type {
  PsiWorkerHandle,
  PsiWorkerInit,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "./psi/psiWorkerEngine";
export { SINGLE_PASS_STAGE_IDS } from "./psi/link";
export type { SinglePassStageId } from "./psi/link";

export { AlgorithmSchema, SEMANTIC_TYPES } from "./types";
export type { Algorithm, HandshakeRole, SemanticType } from "./types";
export {
  DEFAULT_PEER_INACTIVITY_TIMEOUT_MS,
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_POLLING_FREQUENCY_MS,
  FileSyncConnection,
  normalizeFiledropPath,
} from "./connection/fileSyncConnection";
export type {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PresentedHostKey,
  PutOptions,
  PutSource,
} from "./connection/fileSyncConnection";
// Named individually because a FileTransportClient implementation
// outside this package needs it -- the CLI's SFTP adapter decides from it
// whether a path handed to safeDelete is the protocol's own in-flight temp
// write.
export { isProtocolTempName } from "./connection/fileSyncNames";
// The protocol filename grammar, named individually for the console's start-of-run
// notice, which asks for a sweep only when the rendezvous folder holds a file the
// entry guard would refuse over -- by the guard's own classification.
export { isProtocolGrammarName } from "./connection/fileSyncNames";
// The file name byte limit, named individually for the CLI's directory-listing
// guard, which bounds each listed name by it.
export { MAX_FILE_NAME_BYTES } from "./connection/fileSyncRendezvous";
// The teardown notice's leftover-files clause. Published because both apps
// outside this package handle it: the CLI writes the notice holding it, and the
// console matches a run's stderr tail against it.
export { TEARDOWN_LEFTOVER_FILES_CLAUSE } from "./transportTeardownNotice";
export {
  QueuedMessageConnection,
  fromEventConnection,
} from "./connection/messageConnection";
export type { MessageConnection } from "./connection/messageConnection";
export { EncryptedMessageConnection } from "./connection/encryptedMessageConnection";
// The transport-agnostic half of the WebRTC data-channel inbound bound. Published
// because the enforcement point is per-transport and lives outside this package
// (the web app's PeerJS reassembly wrapper), while the constants and the
// structural pre-scan they parameterize must stay one implementation.
export {
  MAX_CHUNKS_PER_REASSEMBLY,
  MAX_CONCURRENT_REASSEMBLIES,
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
  describeFrameStructureRefusal,
  scanFrameStructure,
} from "./connection/binaryPackBounds";
// The PSI set element ceilings the front ends size to: the CLI's heap ceiling
// is the memory a round at the protocol's maximum needs, and a browser party
// states its own lower receive ceiling on its connection.
export {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  MAX_PSI_DECODE_ELEMENTS,
} from "./connection/frameSize";
// The send-side half of the same wire. Published for the same reason: both
// WebRTC transports encode their outbound frames outside this package, and one
// implementation has to produce the bytes a partner's BinaryPack reads.
export { encodeBinaryPackValue } from "./connection/binaryPackEncode";
// The send-side check of the same bound. Published because the CLI's PeerJS
// framing chunks at the same threshold the check charges for.
export { PEERJS_CHUNK_MTU } from "./connection/webrtcOutboundBound";
export {
  formatLogPrefix,
  getLogger,
  getLoggerForVerbosity,
  setLogLevel,
  setDiagnosticSink,
  getDiagnosticSink,
} from "./utils/logger";
export type { DiagnosticSink } from "./utils/logger";
export {
  MAX_TIMER_MS,
  retryPromise,
  withTimeout,
  TimeoutError,
} from "./utils/promise";
// The untrusted-JSON chokepoint. Published because a partner wire frame is
// parsed outside this package too -- the CLI's WebRTC broker signaling client
// reads JSON text off a socket the signaling server and the remote peer both
// feed -- and that parse must be the same structurally-bounded one, not a second
// implementation of it (CONTRIBUTING.md, Untrusted-JSON parsing).
export { parseBoundedJson, JsonStructureBoundError } from "./utils/boundedJson";
export { readBoundedJsonBody } from "./utils/boundedJsonBody";
export type { BoundedJsonBodyResult } from "./utils/boundedJsonBody";
// The split-directory distinctness comparison. Published because the console
// decides, ahead of a mint, whether the two rendezvous locators it would put on an
// invitation endpoint are distinct -- and that verdict has to be the one core's own
// endpoint and connection refines will reach, so the operator meets the name to set
// rather than core's refusal at mint. Comparison only: never the path used on disk
// (see the module header).
export { pathsResolveToSameDir } from "./utils/pathCompare";
// @internal: the CLI config writer (saveConfig) delegates to this snakeize
// direction so the read and write paths share one recurse-and-skip traversal;
// not a stable public API (see the declaration's JSDoc).
export { snakeizeKeys } from "./utils/camelizeKeys";
// The scalar half of that direction, for a call site that names ONE key to
// an operator: a schema error locates its field on the camelized shape, and
// the operator is reading the snake_case document (see the declaration's
// JSDoc).
export { snakeizeKey } from "./utils/camelizeKeys";
// The camelize/snakeize depth and node-count bounds. The invitation decode path
// normalizes transform.params through this bounded camelizeKeys chokepoint
// (the camelize pre-pass in config/invitation.ts), so a pathologically deep
// params is rejected at decode like it is on every other parse path; the CLI's
// invitation-vs-config reconcile (apps/cli/src/config/reconcileDiffs.ts,
// withoutUndefinedDeep) keeps its own depth guard as a safety check for
// that independent recursive walk. See docs/spec/CHANNEL_SECURITY.md.
export {
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
  NodeCountExceededError,
} from "./utils/camelizeKeys";
export { canonicalString, CanonicalEncodingError } from "./utils/canonical";
// The package's one reading of a well-formed UTF-16 string, shared so an editor
// naming the fault before a parse, the terms schema, and the encoder that would
// throw all refuse the same strings.
export { loneSurrogateIndex } from "./utils/wellFormedString";
// The package's one counting unit for a string length bound, shared so a schema
// the web app declares bounds a name the way the wire and the record do.
export { maxCodeUnits } from "./utils/maxCodeUnits";
export { MS_PER_DAY } from "./utils/msPerDay";
// The one count formatter, so the CLI, the web app and this package group
// digits identically and in ASCII.
export { formatCount } from "./utils/formatCount";
export {
  sanitizeForDisplay,
  displayText,
  renderedDisplayCost,
  clipToRenderedCost,
  replaceControlCharactersForDisplay,
  trimPartialControlCharacterMarker,
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "./utils/sanitizeForDisplay";
export type { Displayable } from "./utils/sanitizeForDisplay";
export {
  sanitizeErrorForDisplay,
  sanitizeErrorChainLinks,
  joinErrorCauseChain,
  keepFirstPartyLineBreaks,
  keepFirstPartyLinesWithOperatorText,
  renderedDisplayCostKeepingLineBreaks,
  redactPrivateKeyMaterial,
  redactAndSanitizeForDisplay,
  redactAndFitUnescaped,
  redactAndRenderOperatorSuppliedText,
  createPrivateKeyStreamRedactor,
  holdsPrivateKeyMaterial,
  MAX_ERROR_CAUSE_DEPTH,
} from "./utils/sanitizeErrorForDisplay";
// The operator-origin mark and the partition it carries to the error
// renderer: a fragment the operator supplied reaches them as they typed it,
// while every span nobody marked keeps the escape.
export {
  operatorSuppliedText,
  messageWithOperatorText,
  keepOperatorSuppliedText,
} from "./utils/operatorSuppliedText";
export type { MessageWithOperatorText } from "./utils/operatorSuppliedText";
// The partner-origin brand and its ONE elimination. A consumer outside core
// brands at its own decode chokepoint -- the read that takes bytes off a stream
// somebody else fills -- and has no other way to put those bytes in a message.
export {
  partnerOriginText,
  errorWithPartnerCauseLinks,
} from "./utils/partnerOriginText";
export type { PartnerOriginText } from "./utils/partnerOriginText";
// The delimiting grammar for a linkage-terms value named in an operator-facing
// diagnostic. Exported because the CLI's reconcile refusal and citation-drift
// warning and both consent surfaces name the same class of partner-chosen
// value in the same clause structure, and a second delimiting grammar there
// would be the independent re-implementation the shared-primitive rule exists
// to prevent.
export {
  quoteTermsValue,
  quoteTermsValueList,
  bareTermsValue,
  compatibilityMessage,
  ruleSetCitation,
} from "./config/compatibilityMessage";
export type { CompatibilityMessageFragment } from "./config/compatibilityMessage";
export {
  describeDecodeError,
  rawDecodeErrorDescription,
} from "./utils/describeDecodeError";

export {
  safeParseStandardization,
  safeParseStandardizationTheReaderWrote,
  StandardizationSchema,
} from "./config/standardizationSchema";
export type {
  Standardization,
  StandardizationStep,
} from "./config/standardizationSchema";
export {
  CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS,
  ConnectionConfigSchema,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  DEFAULT_WEBRTC_PEER_TIMEOUT_MS,
  HOST_KEY_FINGERPRINT_REGEX,
  INACTIVITY_TIMEOUT_KEY,
  LOW_POLLING_FREQUENCY_WARN_MS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RELAY_LOCATOR_URL_LENGTH,
  MAX_RELAY_LOCATOR_URLS,
  MAX_TIMEOUT_SECONDS,
  MAX_TOKEN_MAX_AGE_DAYS,
  RelayRegistrarSchema,
  SHARED_SECRET_REGEX,
  StunUrlSchema,
  TurnUrlSchema,
  UNALLOCATED_SERVER_HOST_MESSAGE,
  generateSharedSecret,
  hasMintedTurnEntry,
  safeParseConnectionConfig,
  safeParseConnectionConfigAwaitingAddress,
  safeParseFileSyncOptions,
  statesServerHost,
  withRetainModeImplications,
} from "./config/connection";
export {
  KEY_FILE_FIELD_SCHEMAS,
  KEY_FILE_SHARED_SECRET_FORMAT_MESSAGE,
  KeyFileSchema,
  keyFileUnreadFieldNames,
  rotatedKeyExpires,
  serializeKeyFile,
} from "./config/keyFile";
export type { KeyFile } from "./config/keyFile";
export type {
  Authentication,
  ConnectionConfig,
  ConnectionConfigAwaitingAddress,
  FileDropConnectionConfig,
  FileSyncOptions,
  HttpAuth,
  RelayLocator,
  RelayRegistrar,
  ServerProvision,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "./config/connection";
// Named for the same reason: ServerProvision's mode field is typed by it.
export type { ServerProvisionMode } from "./config/connection";
export {
  BUILT_IN_LINKAGE_RULE_SETS,
  DEFAULT_LINKAGE_RULE_SET,
  OPT_IN_LINKAGE_FIELD_TYPES,
  authoredLinkageFields,
  encodeForComparison,
  findBuiltInLinkageRuleSet,
  getDefaultLinkageTerms,
  isDrawnFromLinkageRuleSet,
  isOptInLinkageKey,
  linkageRuleSetReferenceFor,
  linkageTermsFromRuleSet,
  optInLinkageKeys,
  resolveLinkageRuleSetCitation,
} from "./defaults/builtInLinkageTerms";
export type {
  BuiltInLinkageRuleSet,
  LinkageRuleSetCitationVerdict,
} from "./defaults/builtInLinkageTerms";
export { getDefaultStandardization } from "./defaults/builtInStandardization";
export {
  ExchangeSpecSchema,
  parseExchangeSpec,
  safeParseExchangeSpec,
  retiredSettingIssue,
} from "./config/exchangeSpec";
export type { ExchangeSpec } from "./config/exchangeSpec";
export {
  LINKAGE_CARDINALITIES,
  assertBothSidedDeduplicateImplemented,
  assertDeduplicateImplemented,
  countOnlyShapeViolation,
  swapPairTransformsDiffer,
} from "./linkageTermsPolicy";
export {
  LinkageStrategySchema,
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
  NAME_SHAPE_PATTERN,
  PRIVATE_KEY_IDENTITY_MESSAGE,
  TEXT_CONTROL_CHAR_MESSAGE,
  TEXT_CONTROL_CHAR_PATTERN,
  TEXT_DIRECTION_MESSAGE,
  reasonTermsCannotStateIdentity,
  referencedLinkageFieldNames,
  safeParseLinkageTerms,
  safeParseLinkageTermsTheReaderWrote,
} from "./config/linkageTermsSchema";
export { payloadReceiveFilledNotice } from "./config/recurringTerms";
export {
  MAX_DISPLAYED_PARAMS,
  NULL_IF_BOTH_VALUE_PARAMS_MESSAGE,
  PRIVATE_KEY_FUNCTION_MESSAGE,
  PRIVATE_KEY_PARAM_MESSAGE,
  PRIVATE_KEY_PARAM_NAME_MESSAGE,
  TRANSFORM_PARAM_COUNT_MESSAGE,
} from "./config/transformParamDisplay";
export {
  changedPartnerBoundTerms,
  compareTerms,
  deriveAcceptedLinkageTerms,
  partnerBoundTerms,
  payloadWithoutColumnDescriptions,
  termsDeltaIsEmpty,
} from "./linkageTermsNegotiation";
export type {
  PartnerBoundTerms,
  PayloadColumnsChange,
  TermsDelta,
  PartnerDeduplicateChange,
} from "./linkageTermsNegotiation";
export {
  TermsChangeRefusedError,
  isPartnerProtocolRefusal,
  termsDifferenceRefusedBy,
} from "./protocolSetup";
export type { TermsChange, TermsDifferenceRefusedBy } from "./protocolSetup";
export { termsDeltaSections } from "./termsDeltaDisplay";
export type {
  CountOnlyShapeViolation,
  ResolvedMatching,
} from "./linkageTermsPolicy";
export type {
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageStrategy,
  LinkageTerms,
  Output,
  Payload,
  TransformStep,
} from "./config/linkageTermsSchema";
export {
  INVITATION_ACCEPT_ROUTE_PATH,
  INVITATION_LIFETIME_SECONDS,
  InvitationDecodeError,
  assertInvitationLifetimeSeconds,
  invitationExpires,
  MAX_ENCODED_INVITATION_LENGTH,
  MAX_INVITATION_LIFETIME_SECONDS,
  decodeInvitation,
  encodeInvitation,
  endpointRequiresRetainedFiles,
  hasExpiryInstantPassed,
  isInvitationExpired,
  relayLocatorFromOwnRelay,
  stripInvitationWhitespace,
  WebRTCEndpointSchema,
} from "./config/invitation";
export {
  TermsUpdateRefusedError,
  decodeTermsUpdate,
  encodeTermsUpdate,
  termsUpdateFor,
} from "./config/termsUpdate";
export type { TermsUpdate, TermsUpdateCheck } from "./config/termsUpdate";
export {
  PLACEHOLDER_IDENTITY,
  unnamedPartyIdentity,
} from "./config/partyIdentityLabel";
export type {
  ConnectionEndpoint,
  FileDropEndpoint,
  InvitationToken,
  SFTPEndpoint,
  WebRTCEndpoint,
} from "./config/invitation";
export {
  PLACEHOLDER_SFTP_HOST,
  PLACEHOLDER_SSH_USERNAME,
  endpointFromConnection,
} from "./config/endpointProducer";
export {
  SftpPortSchema,
  formatSftpUrl,
  isBareSftpHost,
  isSftpPort,
  parseSftpServerAddress,
  parseSftpUrl,
  sftpUrlDirectoryFault,
} from "./config/sftpUrl";
export type { SftpUrlFields } from "./config/sftpUrl";
export {
  decodeUrlComponent,
  redactUrlCredentials,
} from "./utils/urlComponents";
export {
  callProvisionEndpoint,
  hostForAuthority,
  provisionEndpointLabel,
  provisionModeOf,
  provisionRequest,
  requestProvisionedServerAddress,
  serverProvisionOf,
  withProvisionedServerAddress,
} from "./config/serverProvision";
export type { ProvisionedServerAddress } from "./config/serverProvision";
export {
  CONNECTION_BLOCK_DOC_URL,
  CONNECTION_BLOCK_NOTICE,
  POLL_INTERVAL_LINES,
} from "./config/connectionGuidance";
export { commentBlock, commentKey } from "./config/yamlComments";
export {
  annotateUnsetPayloadReceive,
  removeUnsetPayloadReceiveNote,
  serializeExchangeDocument,
} from "./config/exchangeDocument";
export {
  assembleExchangeSpec,
  connectionFromLocator,
  mintExchangeFile,
  mintExchangeSpec,
} from "./config/exchangeFile";
export type {
  ExchangeFileConnection,
  ExchangeFileInput,
  ExchangeLocator,
  WebRTCExchangeLocator,
} from "./config/exchangeFile";
export {
  MetadataSchema,
  OwnColumnSelectionSchema,
  assertCountOnlyTransmitsNoColumn,
  countOnlyTransmitsColumn,
  describeUndeclaredColumns,
  disclosedColumnNames,
  inferMetadata,
  inferMetadataForEveryColumn,
  isDisclosedToPartner,
  linkageDateOfBirthColumn,
  overlongDisclosedColumnPositions,
  ownResultColumnNames,
  safeParseMetadata,
  safeParseMetadataTheReaderWrote,
  undeclaredColumnNames,
} from "./config/metadata";
export type {
  ColumnMetadata,
  Metadata,
  OwnColumnSelection,
} from "./config/metadata";
export {
  FINGERPRINT_REGEX,
  partnerPinIsPresent,
  retiredSettingNotice,
  retiredSigningSetting,
  retiredSigningSettingNotice,
} from "./config/signing";
export type { SigningConfig } from "./config/signing";
export {
  SIGNING_CERTIFICATE_VERSION,
  SIGNING_IDENTITY_VERSION,
  certificateAuthorizesIdentity,
  computeCertificateFingerprint,
  generateSigningIdentity,
  parseCertificate,
  parseSigningIdentity,
  serializeCertificate,
  serializeSigningIdentity,
} from "./records/signingIdentity";
export type {
  CertificateBody,
  SigningCertificate,
  SigningIdentity,
} from "./records/signingIdentity";
export {
  FAN_OUT_FUNCTION_NAMES,
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  StandardizedField,
  runPipeline,
  termsDeclareCandidateSet,
} from "./standardization";
export {
  assertFanOutImplemented,
  assertStandardizationMatchesTerms,
  assertTransformsCompile,
  assessLinkageSatisfiability,
  coalesceSubstitutesConstant,
  decideLinkageTermsVerdict,
  stepCanEmptyRealizedValue,
  summarizeLinkageShortfall,
  transformRefusalIn,
} from "./linkageSatisfiability";
export {
  checkValueConstraints,
  summarizeDatasetConstraintViolations,
} from "./valueConstraints";
export type {
  FieldValue,
  StandardizationFunctionDescriptor,
} from "./standardization";
export type {
  LinkageKeyFitness,
  LinkageTermsStanding,
  LinkageTermsVerdict,
  TransformRefusal,
} from "./linkageSatisfiability";

// The one display model both acceptance surfaces render the inviter's proposed
// terms from -- the web consent screen and the CLI accept prompt -- so the
// judgment of what an acceptor is consenting to, and the escaping of every
// partner-controlled string in it, is made once rather than per surface.
export {
  summarizeInvitation,
  withholdsPartnerAssociationTable,
} from "./consent/invitationSummary.js";
export type {
  InvitationKeySummary,
  InvitationRuleSetSummary,
  InvitationSummary,
} from "./consent/invitationSummary.js";
// The classification and caveat copy that go with that display model: whether a
// fact the acceptance surfaces state is enforced by the exchange or rests on the
// partner's word, and the fixed sentences both surfaces render for it.
export {
  CONSENT_BASIS_MARKERS,
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT,
  DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  LINKAGE_RULE_SET_VERDICT_COPY,
  OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
  PROPOSED_NOT_APPLIED_NOTES,
  RECORDED_LINKAGE_RULE_SET_CAVEAT,
  UNRECOGNIZED_TRANSFORM_NOTE,
  describeDeduplicatePair,
  distinctLinkageRuleSetVerdicts,
  linkageRuleSetVerdictNote,
} from "./consent/consentFacts.js";
export type { ConsentFactId } from "./consent/consentFacts.js";
// The count every acceptance surface paints a partner-declared name list under,
// and the sentence a bounded list closes on: one cut and one wording across the
// CLI accept prompt and the two web surfaces.
export {
  MAX_DECLARED_NAMES_SHOWN,
  unshownDeclaredNamesLine,
} from "./consent/declaredNameBound.js";
export {
  CSV_LINE_BYTE_CEILING,
  loadCSVFile,
  streamCSVRows,
  readRowColumn,
  CsvLineByteCeilingError,
} from "./file";
// The one accepted-value rule behind every CSV field delimiter Alcove reads or
// writes with: the default, the reserved detect choice, the spelling resolver,
// the choice predicate, the write-side resolution, the refusal the CLI flag and
// the configuration schema both state, and the clause a column refusal adds for
// a header that read as one column.
export {
  CSV_DELIMITER_DETECT,
  DEFAULT_CSV_DELIMITER,
  csvDelimiterRefusal,
  isCsvDelimiterChoice,
  normalizeCsvDelimiter,
  resultCsvDelimiter,
  singleColumnDelimiterClause,
} from "./csvDelimiter.js";
export type { CSVRow } from "./file";
// The text-direction controls no name may hold. Shared so the ingestion
// boundary, the terms schema's name shape, and the surfaces mirroring the
// identity rule agree on what a name and a recorded free-text value may contain.
export { BIDI_CONTROL_PATTERN } from "./utils/nameControls.js";
export { inferDateInputFormatFromSource } from "./inferDateInputFormat";

export {
  inferDateFormat,
  createDateFormatInferrer,
  columnValues,
} from "./utils/date.js";
export type { DateFormatInferrer } from "./utils/date.js";
export {
  CONFIRMING_PROTOCOL_STAGE_ID,
  assertTermsRunnable,
  countIsPartnerReported,
  describeExchangeStages,
  prepareForExchange,
  resolveExchangeInputs,
  resolveLinkageCardinality,
  runExchange,
  undeclaredColumnsForOwnResult,
} from "./exchange";
export type {
  ExchangeBootstrapResult,
  ExchangeDataSpec,
  ExchangeResult,
  ExchangeStageDefinition,
  PayloadReceiveFillAnswer,
  PreparedExchange,
} from "./exchange";
export { PARTNER_CERTIFICATE_REFUSAL_MESSAGES } from "./exchange/signingChecks";
export type { PartnerCertificateRefusalKind } from "./exchange/signingChecks";
export { assertFirstRoundWithinSetMaximum } from "./exchange/firstRoundCapacity";
export {
  exchangeRecordFromFailure,
  exchangeRecordOwedButUnbuilt,
} from "./exchange/failureRecords";
export {
  describeResolvedMatching,
  describeResolvedRunShape,
  projectPairTable,
} from "./pairTableProjection";
export { describeEntityClusters } from "./entityClusterReport";
export type {
  EntityClusterShape,
  EntityClusterSummary,
} from "./psi/entityClosure";
export { parseAgreedTerms, serializeAgreedTerms } from "./records/agreedTerms";
export type { AgreedTerms } from "./records/agreedTerms";
export {
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_OUTCOMES,
  EXCHANGE_RECORD_VERSION,
  parseExchangeRecord,
  parseVerificationKeys,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "./records/exchangeRecord";
export { recordFileStamp } from "./records/recordFileStamp";
export type {
  BuiltExchangeRecord,
  CommitmentName,
  ExchangeRecord,
  ExchangeRecordOutcome,
  RecordLinkageRuleSet,
  VerificationKeys,
} from "./records/exchangeRecord";
export {
  UNNAMED_PARTY_LABEL,
  displayPartyIdentity,
  redactAndDisplayPartyIdentity,
} from "./records/partyIdentityDisplay";
export {
  ReceiptVerificationError,
  SIGNED_RECEIPT_VERSION,
  parseDualSignedRecord,
  serializeDualSignedRecord,
} from "./records/signedReceipt";
export type { DualSignedRecord } from "./records/signedReceipt";
export {
  deriveOurIdColumn,
  reconstructCommittedData,
  recordAlterationIsTheOnlyExplanation,
  recordedVersionMatches,
  reproductionMismatchCauses,
  resuppliedFilesAreFromAnotherRun,
  toRetainedResult,
  verifyExchangeRecord,
} from "./records/recordVerification";
export type {
  CommitmentStatus,
  RecordVerificationReport,
  ResultSizeStatus,
  TermsHashStatus,
} from "./records/recordVerification";
export {
  anchorsPhrase,
  decideSignedReceiptVerdict,
  partnerTermsForVerification,
  signedRecordExpectations,
  verifyDualSignedRecord,
} from "./records/signedReceiptVerification";
export { OWN_IDENTITY_UNMATCHED_SENTENCE } from "./receiptVerdictText";
export type {
  AnchoredCertificateStatus,
  AssertedIdentityStatus,
  CertificateBindingStatus,
  DualSignedRecordVerificationReport,
  LocalIdentityAnchor,
  LocalIdentitySource,
  ReceiptSignatureStatus,
  RunBindingStatus,
  SignedReceiptVerdictAnchor,
  SignedReceiptVerdictCheck,
  SignedReceiptVerdictGuidance,
  SignedReceiptVerdictHeadline,
  SignedReceiptVerdictParty,
  SignedReceiptVerdictRunBinding,
  SignedRecordExpectationSources,
  UnanchoredCertificateClause,
} from "./records/signedReceiptVerification";
export {
  assertDisclosedNamesCarriable,
  assertPayloadSendDisclosed,
  buildOutputTable,
  termsStatingDeclaredPayloadSend,
  termsAsTheRunStatedThem,
} from "./payloadExchange";
export {
  authenticateConnection,
  assertSharedSecretReadyForHandshake,
  NEW_INVITATION_REMEDY,
  deriveAbortToken,
} from "./auth";
export type { AuthResult } from "./auth";
export {
  authorityMovingSignalingField,
  deriveRendezvousPeerId,
  handshakeRoleForRendezvousRole,
} from "./rendezvous";
export type { RendezvousRole, SignalingLocationField } from "./rendezvous";
export {
  deriveRelayKey,
  mintRelayCredential,
  mintRunRelayCredential,
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  selectRunRelay,
} from "./relayCredential";
export type { RelayCredential } from "./relayCredential";
export {
  enrollRelayKey,
  registerRelayKey,
  RELAY_REGISTRAR_REQUEST_TIMEOUT_MS,
  RELAY_REGISTRATION_RETRY_DELAYS_MS,
  relayRegistrarLabel,
  relayRegistrationBody,
  relayRegistrationNotice,
  REMOVED_CREDENTIAL_TEXT,
  sendRelayRegistration,
} from "./relayRegistrarClient";
export type {
  RelayRegistrarAnswer,
  RelayRegistrarTransport,
  RelayRegistrationEnvironment,
  RelayRegistrationOutcome,
} from "./relayRegistrarClient";
// The shared chokepoint for parsing config/credential documents that may hold
// secrets, so a parse error never leaks source bytes. Consumed by the CLI (file
// reads, via its thin re-export) and the web app (an imported linkage-terms
// document); the raw `yaml` parsers are ESLint-banned outside this module in
// both apps.
export {
  parseSensitiveYaml,
  editSensitiveYamlDocument,
  parseSensitiveJson,
} from "./sensitiveFile";
export type { SensitiveFileLabel } from "./sensitiveFile";

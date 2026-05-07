/**
 * OTA メールパーサーのバージョン定数
 *
 * パーサー (utils/emailParser/airbnb.js, booking.js) を改修したらここを上げる。
 * parse_errors への記録時に保存され、後追いで「どのバージョンで失敗したか」を切り分け可能。
 */
const PARSER_VERSION = "v1.0.0";

module.exports = { PARSER_VERSION };

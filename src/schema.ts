/** Схема SQLite-базы. Собирает её scripts/build-db.ts из дампа `tei-importer export`. */

export const DB_FORMAT = 1;

/** Те же голоса, что в Postgres. */
export const VOICES = ["tolstoy", "quoted", "contemporary", "editor"] as const;
export type Voice = (typeof VOICES)[number];
/** Слова самого Толстого и цитаты в его книгах: фильтр `only_mine`. */
export const MINE_VOICES: readonly Voice[] = ["tolstoy", "quoted"];

export const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE persons (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  life_period TEXT,
  wikidata    TEXT,
  description TEXT
);

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  corpus        TEXT NOT NULL,
  voice         TEXT NOT NULL,
  title         TEXT NOT NULL,
  bibl          TEXT,
  author        TEXT,
  volume        INTEGER,
  pages         TEXT,
  date_from     TEXT,
  date_to       TEXT,
  date_text     TEXT,
  addressee_id  INTEGER REFERENCES persons,
  source_path   TEXT NOT NULL,
  segment_count INTEGER NOT NULL
);

-- Обычная rowid-таблица: WITHOUT ROWID плохо хранит длинные строки (почти вдвое больше места).
-- text: text_orig без ударений и лишних пробелов (дореформенная орфография, где она есть в источнике)
CREATE TABLE segments (
  doc_id      TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  voice       TEXT NOT NULL,
  attribution TEXT,
  page_from   TEXT,
  text        TEXT NOT NULL
);
CREATE UNIQUE INDEX segments_ord_idx ON segments (doc_id, ord);
CREATE INDEX segments_id_idx ON segments (doc_id, id);

-- id совпадает с rowid в chunks_fts и chunk_vectors
CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  voice       TEXT NOT NULL,
  is_note     INTEGER NOT NULL,
  segment_ids TEXT NOT NULL,  -- JSON-массив segments.id по порядку
  header      TEXT NOT NULL   -- «Толстой. Письмо А. А. Фету, 30 августа 1869»
);

-- int8-вектор bge-m3: round(v * scale) с отсечкой до ±127, scale лежит в meta
CREATE TABLE chunk_vectors (
  id        INTEGER PRIMARY KEY,
  mine      INTEGER NOT NULL,  -- voice in (tolstoy, quoted)
  embedding BLOB NOT NULL
);

-- основы слов (Snowball) заголовка чанка и текста в современной орфографии
CREATE VIRTUAL TABLE chunks_fts USING fts5(head, body, content='', tokenize='unicode61 remove_diacritics 2');
`;

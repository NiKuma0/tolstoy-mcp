/**
 * Текст: очистка как в Python-импортёре и стемминг для полнотекстового поиска.
 *
 * В SQLite FTS5 нет русского стеммера, поэтому и текст для индекса, и запрос заранее
 * прогоняются через Snowball здесь, а FTS5 просто делит готовые основы по пробелам.
 */
import snowball from "snowball-stemmers";

const STRESS = /[̀́]/g; // знаки ударения: «Си́ксне» → «Сиксне»

/** То же, что tei_importer.chunks.clean: без ударений, пробелы схлопнуты. */
export function clean(text: string): string {
  return text.normalize("NFD").replace(STRESS, "").normalize("NFC").split(/\s+/u).filter(Boolean).join(" ");
}

// Стоп-слова Snowball для русского: в OR-запросе «что», «о», «как» совпадают почти с каждым чанком.
const STOP_WORDS = new Set(
  `и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от
  меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж
  вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без
  будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один
  почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после
  над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед
  иногда лучше чуть том нельзя такой им более всегда конечно всю между
  the a an of and or to in on is are was were be it that this with for as at by from not`.split(/\s+/),
);

const ru = snowball.newStemmer("russian");
const en = snowball.newStemmer("english");
const CYRILLIC = /[а-я]/;
const LATIN = /^[a-z]+$/;

/** Основы слов текста: нижний регистр, ё → е, без стоп-слов. */
export function stems(text: string): string[] {
  const words =
    clean(text)
      .toLowerCase()
      .replaceAll("ё", "е")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    if (CYRILLIC.test(w)) out.push(ru.stem(w));
    else if (LATIN.test(w)) out.push(en.stem(w));
    else out.push(w);
  }
  return out;
}

/** Текст для колонки FTS5: основы через пробел. */
export function ftsText(text: string): string {
  return stems(text).join(" ");
}

/**
 * Запрос FTS5: основы через OR. AND по всем словам почти никогда не находит абзац,
 * а частые слова bm25 почти не учитывает из-за низкого IDF. Поэтому префикс «Толстой. …» в заголовке
 * чанка безвреден: «толст» есть почти везде. Если его вырезать, «Толстой» в запросе станет редким словом
 * и поднимет тексты о Толстом (воспоминания, «Вблизи Толстого») выше его собственных.
 */
export function ftsQuery(text: string): string | null {
  const unique = [...new Set(stems(text))];
  return unique.length ? unique.map((s) => `"${s}"`).join(" OR ") : null;
}

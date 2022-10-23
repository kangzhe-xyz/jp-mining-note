
/// {% set globals %}

// global cache for an entire card's kanji hover html
// maps key.word_reading -> html string
//var kanjiHoverCardCache = kanjiHoverCardCache ?? {};
var kanjiHoverCardCache = nullish(kanjiHoverCardCache, {});

// maps kanji -> [{set of used words}, html string]
//var kanjiHoverCache = kanjiHoverCache ?? {};
var kanjiHoverCache = nullish(kanjiHoverCache, {});


/// {% endset %}






/// {% set functions %}

// =============
//  Kanji Hover
// =============

const JPMNKanjiHover = (() => {

  const logger = new JPMNLogger("kanji-hover");

  // element outside async function to prevent double-adding due to anki funkyness
  const wordReading = document.getElementById("dh_reading");
  let kanjiHoverEnabled = false;

  // multi query result, in the format of
  // [kanji 1 (non-new), kanji 1 (new), kanji 2 (non-new), kanji 2 (new), etc.]
  async function cardQueries(kanjiArr) {
    const cardTypeName = '{{ NOTE_FILES("templates", note.card_type, "name").item() }}';

    function constructFindCardAction(query) {
      return {
        "action": "findCards",
        "params": {
          "query": query,
        }
      }
    }

    // constructs the multi findCards request for ankiconnect
    let actions = [];
    for (const character of kanjiArr) {
      const baseQuery = (
        `(-"Key:{{ T('Key') }}" -"WordReading:{{ T('WordReading') }}"`
        + `Word:*${character}* "card:${cardTypeName}") `
      );
      const nonNewQuery = baseQuery + {{ utils.opt("modules", "kanji-hover", "non-new-query") }};
      const newQuery = baseQuery + {{ utils.opt("modules", "kanji-hover", "new-query") }};

      actions.push(constructFindCardAction(nonNewQuery))
      actions.push(constructFindCardAction(newQuery))
    }

    return await invoke("multi", {"actions": actions})
  }

  //function filterCards(nonNewCardIds, newCardIds) {
  //  const nonNewEarliest = {{ utils.opt("modules", "kanji-hover", "max-non-new-oldest") }};
  //  const nonNewLatest = {{ utils.opt("modules", "kanji-hover", "max-non-new-latest") }};
  //  const newLatest = {{ utils.opt("modules", "kanji-hover", "max-new-latest") }};

  //  // non new: gets the earliest and latest
  //  let nonNewResultIds = []
  //  if (nonNewCardIds.length > nonNewEarliest + nonNewLatest) {
  //    nonNewResultIds = [
  //      ...nonNewCardIds.slice(0, nonNewEarliest), // earliest
  //      ...nonNewCardIds.slice(-nonNewLatest, nonNewCardIds.length), // latest
  //    ];
  //  } else {
  //    nonNewResultIds = [...nonNewCardIds];
  //  }

  //  let newResultIds = newCardIds.slice(0, newLatest);

  //  return [nonNewResultIds, newResultIds];
  //}



  async function getCardsInfo(queryResults, ankiConnectHelper) {
    function constructCardsInfoAction(idList) {
      return {
        "action": "cardsInfo",
        "params": {
          "cards": idList,
        }
      }
    }

    let actions = [];
    logger.assert(queryResults.length % 2 == 0, "query results not even");

    for (let i = 0; i < queryResults.length/2; i++) {
      // ids are equivalent to creation dates, so sorting ids is equivalent to
      // sorting to card creation date
      const nonNewCardIds = queryResults[i*2].sort();
      const newCardIds = queryResults[i*2 + 1].sort();

      const maxNonNewOldest = {{ utils.opt("modules", "kanji-hover", "max-non-new-oldest") }};
      const maxNonNewLatest = {{ utils.opt("modules", "kanji-hover", "max-non-new-latest") }};
      const maxNewLatest = {{ utils.opt("modules", "kanji-hover", "max-new-latest") }};

      const [nonNewResultIds, newResultIds] = ankiConnectHelper.filterCards(
        nonNewCardIds, newCardIds,
        maxNonNewOldest, maxNonNewLatest, maxNewLatest
      );

      // creates a multi request of the following format:
      // [cardInfo (nonNewCardIds, kanji 1), cardInfo (newCardIds, kanji 1), etc.]
      actions.push(constructCardsInfoAction(nonNewResultIds));
      actions.push(constructCardsInfoAction(newResultIds));
    }

    return await invoke("multi", {"actions": actions});
  }


  function buildString(character, nonNewCardInfo, newCardInfo, tooltipBuilder) {

    /*
     * <span class="kanji-hover-wrapper">
     *   <span class="kanji-hover-text"> (kanji) </span>
     *   <span class="kanji-hover-tooltip-wrapper">
     *     <span class="kanji-hover-tooltip"> ... </span>
     *   </span>
     * </span>
     *
     */

    // wrapper element that isn't used, to get the inner html

    const kanjiHoverWrapper = document.createElement('span');
    kanjiHoverWrapper.classList.add("kanji-hover-wrapper");

    const kanjiSpan = document.createElement('span');
    kanjiSpan.classList.add("kanji-hover-text");
    kanjiSpan.innerText = character;

    tooltipWrapperSpan = document.createElement('span');
    tooltipWrapperSpan.classList.add("kanji-hover-tooltip-wrapper");

    tooltipSpan = document.createElement('span');
    tooltipSpan.classList.add("kanji-hover-tooltip");

    let count = 0;


    for (const card of nonNewCardInfo) {
      const cardDiv = tooltipBuilder.buildCardDiv(card, character);
      if (count >= 1) {
        cardDiv.classList.add("kanji-hover-tooltip--not-first");
      }
      count++;

      tooltipSpan.appendChild(cardDiv);
    }

    for (const card of newCardInfo) {
      const cardDiv = tooltipBuilder.buildCardDiv(card, character, isNew=true);
      if (count >= 1) {
        cardDiv.classList.add("kanji-hover-tooltip--not-first");
      }
      count++;

      tooltipSpan.appendChild(cardDiv);
    }


    // 0 length checks
    if (nonNewCardInfo.length + newCardInfo.length == 0) {
      tooltipSpan.innerText = "No other kanjis found.";
    }

    tooltipWrapperSpan.appendChild(tooltipSpan)
    kanjiHoverWrapper.appendChild(kanjiSpan);
    kanjiHoverWrapper.appendChild(tooltipWrapperSpan);

    return kanjiHoverWrapper.outerHTML;
  }


  function getWordReadings(nonNewCardInfo, newCardInfo) {
    let wordsArr = []

    for (const card of nonNewCardInfo) {
      wordsArr.push(card["fields"]["WordReading"]["value"])
    }
    for (const card of newCardInfo) {
      wordsArr.push(card["fields"]["WordReading"]["value"])
    }

    return wordsArr;
  }



  // kanji hover
  // some code shamelessly stolen from cade's kanji hover:
  // https://github.com/cademcniven/Kanji-Hover/blob/main/_kanjiHover.js

  async function kanjiHover(tooltipBuilder, ankiConnectHelper) {

    if (kanjiHoverEnabled) {
      logger.debug("Kanji hover is already enabled");
      return;
    }
    kanjiHoverEnabled = true;

    // realistically, key should be good enough since we assume that key has no duplicates
    // however, just in case, wordreading is added
    const cacheKey = "{{ T('Key') }}.{{ T('WordReading') }}"
    if (cacheKey in kanjiHoverCardCache) {
      logger.debug("Card was cached")
      wordReading.innerHTML = kanjiHoverCardCache[cacheKey];
      return;
    }

    const readingHTML = wordReading.innerHTML;

    // uses cache if it already exists
    let kanjiSet = new Set() // set of kanjis that requires api calls
    const regex = /([\u4E00-\u9FAF])(?![^<]*>|[^<>]*<\/g)/g;
    const matches = readingHTML.matchAll(regex);
    for (const match of matches) {
      kanjiSet.add(...match);
    }

    let kanjiDict = {};
    let wordReadings = {}; // used only for the cache

    // attempts to fill out the kanji dict with cached entries
    for (let kanji of [...kanjiSet]) {
      // also checks that the current word is not used
      if ((kanji in kanjiHoverCache) && !(kanjiHoverCache[kanji][0].includes("{{ T('WordReading') }}"))) {
        logger.debug(`Using cached kanji ${kanji}`)
        kanjiDict[kanji] = kanjiHoverCache[kanji][1];
        kanjiSet.delete(kanji);
      }
    }

    // only calls the api on the needed kanjis
    const kanjiArr = [...kanjiSet];
    const queryResults = await cardQueries(kanjiArr);
    const cardsInfo = await getCardsInfo(queryResults, ankiConnectHelper);

    logger.debug(`New kanjis: [${kanjiArr.join(", ")}]`)

    for (const [i, character] of kanjiArr.entries()) {
      let nonNewCardInfo = cardsInfo[i*2];
      let newCardInfo = cardsInfo[i*2 + 1];

      // attempts to insert string
      kanjiDict[character] = buildString(character, nonNewCardInfo, newCardInfo, tooltipBuilder);
      wordReadings[character] = getWordReadings(nonNewCardInfo, newCardInfo);
    }

    const re = new RegExp(Object.keys(kanjiDict).join("|"), "gi");
    const resultHTML = readingHTML.replace(re, function (matched) {
      //return kanjiDict[matched] ?? matched;
      return nullish(kanjiDict[matched], matched);
    });

    wordReading.innerHTML = resultHTML;

    // caches card
    kanjiHoverCardCache[cacheKey] = resultHTML;

    for (const character of kanjiArr) {
      kanjiHoverCache[character] = [wordReadings[character], kanjiDict[character]];
    }

  }


  class JPMNKanjiHover {
    constructor() {
      this.tooltipBuilder = new JPMNTooltipBuilder();
      this.ankiConnectHelper = new JPMNAnkiConnectActions();
    }

    async run() {
      kanjiHover(this.tooltipBuilder, this.ankiConnectHelper);
    }
  }


  return JPMNKanjiHover;

})();

/// {% endset %}






/// {% set run %}

// only continues if kanji-hover is actually enabled
if ({{ utils.opt("modules", "kanji-hover", "enabled") }}) {
  const kanjiHover = new JPMNKanjiHover()
  if ({{ utils.opt("modules", "kanji-hover", "mode") }} === 0) {
    kanjiHover.run();
  } else { // === 1
    const wordReading = document.getElementById("dh_reading");
    wordReading.onmouseover = function() {
      // replaces the function with a null function to avoid calling this function
      wordReading.onmouseover = function() {}
      kanjiHover.run();
    }
  }
}

/// {% endset %}

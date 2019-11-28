import retext from "retext";
import keywords from "retext-keywords";
import toString from "nlcst-to-string";
import { isValidKeyword } from "api-clients/VocabularyApis";

/** The maximum number of characters to feed into retext (input after this char length will be trimmed off) */
const MAX_CHARACTERS_FOR_EXTRACTION = 150000;
/** The maximum number of keywords to return */
export const MAX_KEYWORDS = 10;

/**
 * Extract keywords from text based file formats
 */
export async function extractKeywords(
    input: {
        text: string;
        keywords: string[];
        skippedCellForKeywords: boolean;
    },
    output: { keywords: string[] }
) {
    let keywords = [] as string[];

    console.log(input.skippedCellForKeywords);

    if (input.text && input.skippedCellForKeywords !== false) {
        // Only take up to a certain length - anything longer results in massive delays and the browser
        // prompting with a "Should I stop this script?" warning.
        const trimmedText = input.text.slice(0, MAX_CHARACTERS_FOR_EXTRACTION);

        const candidateKeywords = keywords.concat(
            await getKeywordsFromText(trimmedText)
        );

        const validatedKeywords: string[] = [];
        for (let i = 0; i < candidateKeywords.length; i++) {
            const result = await isValidKeyword(candidateKeywords[i]);
            if (result) {
                validatedKeywords.push(candidateKeywords[i]);
            }
        }

        // Put the validated keywords first, if there's room fill it with the best candidate keywords.
        keywords = [
            ...validatedKeywords,
            ...candidateKeywords.slice(
                0,
                MAX_KEYWORDS - validatedKeywords.length
            )
        ].map(keyword => keyword.toLowerCase());
    }

    console.log(keywords);

    // --- Ignore headers keywords if already generate enough from NLP
    // --- or header keywords not exists
    if (
        keywords.length >= MAX_KEYWORDS ||
        (!input.keywords || !input.keywords.length)
    ) {
        output.keywords = keywords;
        return;
    }

    // --- fill keywords with header / cell keywords
    output.keywords = [
        ...keywords,
        ...input.keywords.slice(0, MAX_KEYWORDS - keywords.length)
    ];
}

function getKeywordsFromText(
    text: string,
    maximum: number = MAX_KEYWORDS * 2
): Promise<string[]> {
    return new Promise(async (resolve, reject) => {
        retext()
            .use(keywords, {
                maximum
            })
            .process(text, done);

        function done(err, file) {
            if (err) throw err;
            let keyphrases: string[] = [];
            file.data.keyphrases.forEach(function(phrase) {
                keyphrases.push(phrase.matches[0].nodes.map(toString).join(""));
            });
            resolve(keyphrases);
        }
    });
}



async function testFetch() {
    const urls = [
        "https://apihub.kma.go.kr/api/typ01/url/stn_snow.php?stn=&tm=201601051200&mode=0&help=1&authKey=KkmPfomzTJyJj36Js9ycNQ",
        "https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=tot&tm=202403021800&help=1&authKey=KkmPfomzTJyJj36Js9ycNQ",
        "https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=day&tm=202403021800&help=1&authKey=KkmPfomzTJyJj36Js9ycNQ"
    ];

    for (const url of urls) {
        console.log(`\n--- Fetching: ${url} ---\n`);
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buffer);
        console.log(text.split('\n').slice(0, 20).join('\n'));
    }
}

testFetch();

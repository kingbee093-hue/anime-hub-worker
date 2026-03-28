const axios = require('axios');
const TOP_GENRES = [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo',
    'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 
    'Slice of Life', 'Sports', 'Supernatural', 'Thriller'
];
async function test() {
  for(const g of TOP_GENRES) {
    try {
      await axios.post('https://graphql.anilist.co', {
        query: `query { Page(page: 1, perPage: 1) { media(genre: "${g}") { id } } }`
      });
      console.log(g, 'OK');
    } catch(e) {
      console.log(g, 'FAILED', e.response?.data?.errors);
    }
  }
}
test();

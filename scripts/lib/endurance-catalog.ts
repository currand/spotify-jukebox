export interface CatalogSong {
  query: string;
  name: string;
  artist: string;
}

export const SONG_CATALOG: CatalogSong[] = [
  { query: "bohemian rhapsody", name: "Bohemian Rhapsody", artist: "Queen" },
  { query: "uptown funk", name: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars" },
  { query: "shake it off", name: "Shake It Off", artist: "Taylor Swift" },
  { query: "sweet caroline", name: "Sweet Caroline", artist: "Neil Diamond" },
  { query: "don't stop believin", name: "Don't Stop Believin'", artist: "Journey" },
  { query: "living on a prayer", name: "Livin' on a Prayer", artist: "Bon Jovi" },
  { query: "dancing queen", name: "Dancing Queen", artist: "ABBA" },
  { query: "mr brightside", name: "Mr. Brightside", artist: "The Killers" },
  { query: "dreams", name: "Dreams", artist: "Fleetwood Mac" },
  { query: "billie jean", name: "Billie Jean", artist: "Michael Jackson" },
  { query: "hotel california", name: "Hotel California", artist: "Eagles" },
  { query: "wonderwall", name: "Wonderwall", artist: "Oasis" },
  { query: "smells like teen spirit", name: "Smells Like Teen Spirit", artist: "Nirvana" },
  { query: "hey jude", name: "Hey Jude", artist: "The Beatles" },
  { query: "respect", name: "Respect", artist: "Aretha Franklin" },
  { query: "superstition", name: "Superstition", artist: "Stevie Wonder" },
  { query: "purple rain", name: "Purple Rain", artist: "Prince" },
  { query: "watermelon sugar", name: "Watermelon Sugar", artist: "Harry Styles" },
  { query: "blinding lights", name: "Blinding Lights", artist: "The Weeknd" },
  { query: "levitating", name: "Levitating", artist: "Dua Lipa" },
  { query: "bad guy", name: "bad guy", artist: "Billie Eilish" },
  { query: "shape of you", name: "Shape of You", artist: "Ed Sheeran" },
  { query: "rolling in the deep", name: "Rolling in the Deep", artist: "Adele" },
  { query: "get lucky", name: "Get Lucky", artist: "Daft Punk" },
  { query: "locked out of heaven", name: "Locked Out of Heaven", artist: "Bruno Mars" },
  { query: "24k magic", name: "24K Magic", artist: "Bruno Mars" },
  { query: "girls just want to have fun", name: "Girls Just Want to Have Fun", artist: "Cyndi Lauper" },
  { query: "take on me", name: "Take On Me", artist: "a-ha" },
  { query: "never gonna give you up", name: "Never Gonna Give You Up", artist: "Rick Astley" },
  { query: "don't stop me now", name: "Don't Stop Me Now", artist: "Queen" },
  { query: "we will rock you", name: "We Will Rock You", artist: "Queen" },
  { query: "somebody to love", name: "Somebody to Love", artist: "Queen" },
  { query: "under pressure", name: "Under Pressure", artist: "Queen & David Bowie" },
  { query: "crazy little thing called love", name: "Crazy Little Thing Called Love", artist: "Queen" },
  { query: "i wanna dance with somebody", name: "I Wanna Dance with Somebody", artist: "Whitney Houston" },
  { query: "celebration", name: "Celebration", artist: "Kool & The Gang" },
  { query: "jump", name: "Jump", artist: "Van Halen" },
  { query: "summer of 69", name: "Summer of '69", artist: "Bryan Adams" },
  { query: "livin la vida loca", name: "Livin' La Vida Loca", artist: "Ricky Martin" },
  { query: "hey ya", name: "Hey Ya!", artist: "OutKast" },
];

const STRESS_SUFFIXES = ["remix", "live", "acoustic", "cover", "version"];

export function pickSearchQuery(cacheStress: boolean): CatalogSong {
  if (cacheStress && Math.random() < 0.4) {
    const suffix = STRESS_SUFFIXES[Math.floor(Math.random() * STRESS_SUFFIXES.length)]!;
    return {
      query: `party ${Math.floor(Math.random() * 1000)} ${suffix}`,
      name: "Unknown",
      artist: "Unknown",
    };
  }
  return SONG_CATALOG[Math.floor(Math.random() * SONG_CATALOG.length)]!;
}

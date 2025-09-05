// Vercel serverless function for Musicpal API

// CORS headers for frontend
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Simple in-memory storage for users (in production, use a database)
const users = new Map();

// Spotify service functionality
class SpotifyService {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.clientId = process.env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
    
    if (!this.clientId || !this.clientSecret) {
      console.warn("Spotify API credentials not found. Music functionality will be limited.");
    }
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error("Spotify API credentials not configured");
    }

    try {
      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        },
        body: "grant_type=client_credentials",
      });

      if (!response.ok) {
        throw new Error(`Spotify auth failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;

      return this.accessToken;
    } catch (error) {
      console.error("Failed to get Spotify access token:", error);
      throw error;
    }
  }

  async spotifyRequest(endpoint) {
    const token = await this.getAccessToken();
    
    const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async searchTracks(query, limit = 20) {
    try {
      const data = await this.spotifyRequest(`/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`);
      return data.tracks.items || [];
    } catch (error) {
      console.error("Error searching tracks:", error);
      return [];
    }
  }

  async getTrendingTracks() {
    try {
      // Get trending tracks from featured playlists
      const data = await this.spotifyRequest('/browse/featured-playlists?limit=1');
      
      if (data.playlists && data.playlists.items.length > 0) {
        const playlistId = data.playlists.items[0].id;
        const playlistTracks = await this.spotifyRequest(`/playlists/${playlistId}/tracks?limit=20`);
        return playlistTracks.items.map(item => item.track).filter(track => track && track.preview_url);
      }
      
      // Fallback to searching for popular tracks
      return this.searchTracks("top hits 2024", 20);
    } catch (error) {
      console.error("Error fetching trending tracks:", error);
      return [];
    }
  }

  async getRecommendations(genres, limit = 20) {
    try {
      const spotifyGenres = genres.map(g => g.toLowerCase().replace(/\s+/g, '-'));
      const seedGenres = spotifyGenres.slice(0, 5).join(',');
      
      const data = await this.spotifyRequest(`/recommendations?seed_genres=${seedGenres}&limit=${limit}&market=US`);
      return data.tracks || [];
    } catch (error) {
      console.error("Error fetching recommendations:", error);
      const genreQuery = genres.join(' ');
      return this.searchTracks(genreQuery, limit);
    }
  }

  async getTracksByIds(trackIds) {
    try {
      if (trackIds.length === 0) return [];
      
      const chunks = [];
      for (let i = 0; i < trackIds.length; i += 50) {
        chunks.push(trackIds.slice(i, i + 50));
      }
      
      const allTracks = [];
      
      for (const chunk of chunks) {
        const ids = chunk.join(',');
        const data = await this.spotifyRequest(`/tracks?ids=${ids}&market=US`);
        if (data.tracks) {
          allTracks.push(...data.tracks.filter(track => track !== null));
        }
      }
      
      return allTracks;
    } catch (error) {
      console.error("Error fetching tracks by IDs:", error);
      return [];
    }
  }
}

const spotifyService = new SpotifyService();

// Helper function to parse URL and query parameters
function parseRequest(req) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  return {
    pathname: url.pathname,
    searchParams: url.searchParams,
    method: req.method
  };
}

// Helper function to send JSON response
function sendJSON(res, data, status = 200) {
  res.status(status);
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(data);
}

// Helper function to send error response
function sendError(res, message, status = 500) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }
  res.json({ message });
}

// Main serverless function
export default async function handler(req, res) {
  // Set CORS headers
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { pathname, searchParams, method } = parseRequest(req);

  try {
    // Spotify search endpoint
    if (pathname === '/api/spotify/search' && method === 'GET') {
      const query = searchParams.get('q');
      if (!query) {
        return sendError(res, "Query parameter 'q' is required", 400);
      }
      
      const results = await spotifyService.searchTracks(query);
      return sendJSON(res, { tracks: { items: results } });
    }

    // Spotify trending endpoint
    if (pathname === '/api/spotify/trending' && method === 'GET') {
      const tracks = await spotifyService.getTrendingTracks();
      return sendJSON(res, tracks);
    }

    // Spotify recommendations endpoint
    if (pathname === '/api/spotify/recommendations' && method === 'GET') {
      const seedGenres = searchParams.get('seed_genres');
      if (!seedGenres) {
        return sendError(res, "Query parameter 'seed_genres' is required", 400);
      }
      
      const genres = seedGenres.split(',').filter(g => g.trim());
      const recommendations = await spotifyService.getRecommendations(genres);
      return sendJSON(res, recommendations);
    }

    // Spotify tracks by IDs endpoint
    if (pathname === '/api/spotify/tracks' && method === 'GET') {
      const ids = searchParams.get('ids');
      if (!ids) {
        return sendError(res, "Query parameter 'ids' is required", 400);
      }
      
      const trackIds = ids.split(',').filter(id => id.trim());
      if (trackIds.length === 0) {
        return sendJSON(res, { tracks: [] });
      }
      
      const tracks = await spotifyService.getTracksByIds(trackIds);
      return sendJSON(res, { tracks });
    }

    // Users endpoints (simplified for serverless)
    if (pathname === '/api/users' && method === 'POST') {
      const { username, genres } = req.body || {};
      
      if (!username) {
        return sendError(res, "Username is required", 400);
      }
      
      // Check if user already exists
      const existingUser = Array.from(users.values()).find(user => user.username === username);
      if (existingUser) {
        return sendError(res, "Username already exists", 409);
      }
      
      const user = {
        id: Date.now().toString(),
        username,
        genres: genres || [],
        likedSongs: [],
        recentSongs: [],
        createdAt: new Date().toISOString()
      };
      
      users.set(user.id, user);
      return sendJSON(res, user);
    }

    if (pathname.startsWith('/api/users/') && method === 'PATCH') {
      const userId = pathname.split('/')[3];
      const updates = req.body || {};
      
      const user = users.get(userId);
      if (!user) {
        return sendError(res, "User not found", 404);
      }
      
      const updatedUser = { ...user, ...updates };
      users.set(userId, updatedUser);
      return sendJSON(res, updatedUser);
    }

    // Spotify OAuth callback
    if (pathname === '/callback' && method === 'GET') {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const error = searchParams.get('error');
      
      if (error) {
        // Redirect back to app with error
        res.writeHead(302, { 'Location': `/?error=${encodeURIComponent(error)}` });
        res.end();
        return;
      }
      
      if (code) {
        // Exchange code for access token (implement this when needed)
        // For now, redirect back to app with success
        res.writeHead(302, { 'Location': `/?connected=true` });
        res.end();
        return;
      }
      
      // Redirect back to app
      res.writeHead(302, { 'Location': '/' });
      res.end();
      return;
    }

    // Route not found
    return sendError(res, "Route not found", 404);

  } catch (error) {
    console.error("API Error:", error);
    return sendError(res, "Internal server error", 500);
  }
}

import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MARKETPLACE_DATA_DIR = path.join(__dirname, '../../data/marketplace');
const MAX_REVIEW_LENGTH = 5000;
const MAX_RATING = 5;
const MIN_RATING = 1;
const REVIEW_COOLDOWN_MS = 60000;
const SERVICE_LISTING_TTL = 7 * 24 * 60 * 60 * 1000;

// P1 NGEN sink: capability market escrow. Mirrors the taskProtocol escrow
// pattern — buyer funds are locked at purchase time and released to the
// seller (listing.agentId's wallet) on completion, or refunded on cancel.
const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';

class AgentMarketplace {
  // Static reference to blockchain state. May be a state object or a lazy
  // getter function () => state. The getter form is preferred because the
  // state may not exist at module-import time (genesisNode boots after
  // marketplace module is loaded).
  static blockchainState = null;

  static setBlockchainState(state) {
    AgentMarketplace.blockchainState = state;
    console.log('[AgentMarketplace] Blockchain state injected — P1 escrow sink ACTIVE');
  }

  // Resolve the live blockchain state. Supports both direct injection and
  // lazy getter functions injected by the HTTP server layer.
  _getState() {
    const s = AgentMarketplace.blockchainState;
    if (typeof s === 'function') return s();
    return s;
  }

  constructor(agentManager = null, discoveryService = null) {
    this.agentManager = agentManager;
    this.discoveryService = discoveryService;
    this.eventEmitter = new EventEmitter();

    this.listings = new Map();
    this.reviews = new Map();
    this.ratings = new Map();
    this.transactions = new Map();
    this.categories = new Set();

    // P4 NGEN sink: competitive auction escrow. External users publish a
    // demand with a locked NGEN reward; agents bid; the winner is paid from
    // escrow and the remainder is refunded to the publisher.
    this.auctions = new Map();

    // P4 NGEN sink: subscription stream. External users pay NGEN per cycle
    // to continuously receive an agent's services (periodic reports, alerts,
    // data pushes, etc.). `subscriptions` stores agent-published plans;
    // `subscriptionPayments` stores per-cycle payment records.
    this.subscriptions = new Map();
    this.subscriptionPayments = new Map();

    this._initDirectories();
    this._loadData();
  }

  _initDirectories() {
    if (!fs.existsSync(MARKETPLACE_DATA_DIR)) {
      fs.mkdirSync(MARKETPLACE_DATA_DIR, { recursive: true });
    }
  }

  _loadData() {
    try {
      const listingsFile = path.join(MARKETPLACE_DATA_DIR, 'listings.json');
      if (fs.existsSync(listingsFile)) {
        const data = JSON.parse(fs.readFileSync(listingsFile, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.listings.set(key, value);
        }
      }
    } catch (e) { /* ignore */ }

    try {
      const reviewsFile = path.join(MARKETPLACE_DATA_DIR, 'reviews.json');
      if (fs.existsSync(reviewsFile)) {
        const data = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.reviews.set(key, value);
        }
      }
    } catch (e) { /* ignore */ }

    try {
      const ratingsFile = path.join(MARKETPLACE_DATA_DIR, 'ratings.json');
      if (fs.existsSync(ratingsFile)) {
        const data = JSON.parse(fs.readFileSync(ratingsFile, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.ratings.set(key, value);
        }
      }
    } catch (e) { /* ignore */ }

    try {
      const txFile = path.join(MARKETPLACE_DATA_DIR, 'transactions.json');
      if (fs.existsSync(txFile)) {
        const data = JSON.parse(fs.readFileSync(txFile, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.transactions.set(key, value);
        }
      }
    } catch (e) { /* ignore */ }

    try {
      const subsFile = path.join(MARKETPLACE_DATA_DIR, 'subscriptions.json');
      if (fs.existsSync(subsFile)) {
        const data = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          // Restore nested subscribers map/object
          if (value && !value.subscribers) value.subscribers = {};
          this.subscriptions.set(key, value);
        }
      }
    } catch (e) { /* ignore */ }

    try {
      const payFile = path.join(MARKETPLACE_DATA_DIR, 'subscription_payments.json');
      if (fs.existsSync(payFile)) {
        const data = JSON.parse(fs.readFileSync(payFile, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.subscriptionPayments.set(key, value);
        }
      }
    } catch (e) { /* ignore */ }

    try {
      const auctionsFile = path.join(MARKETPLACE_DATA_DIR, 'auctions.json');
      if (fs.existsSync(auctionsFile)) {
        const data = JSON.parse(fs.readFileSync(auctionsFile, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.auctions.set(key, value);
        }
      }
    } catch (e) { /* ignore */ }
  }

  _saveData() {
    try {
      const listingsObj = Object.fromEntries(this.listings);
      fs.writeFileSync(
        path.join(MARKETPLACE_DATA_DIR, 'listings.json'),
        JSON.stringify(listingsObj, null, 2)
      );
    } catch (e) { /* ignore */ }

    try {
      const reviewsObj = Object.fromEntries(this.reviews);
      fs.writeFileSync(
        path.join(MARKETPLACE_DATA_DIR, 'reviews.json'),
        JSON.stringify(reviewsObj, null, 2)
      );
    } catch (e) { /* ignore */ }

    try {
      const ratingsObj = Object.fromEntries(this.ratings);
      fs.writeFileSync(
        path.join(MARKETPLACE_DATA_DIR, 'ratings.json'),
        JSON.stringify(ratingsObj, null, 2)
      );
    } catch (e) { /* ignore */ }
  }

  listService(agentId, serviceData) {
    if (!agentId || !serviceData.name) {
      return { success: false, reason: 'agentId and service name are required' };
    }

    if (!serviceData.capabilities || !Array.isArray(serviceData.capabilities) || serviceData.capabilities.length === 0) {
      return { success: false, reason: 'At least one capability is required' };
    }

    const listingId = crypto.randomUUID();
    const listing = {
      id: listingId,
      agentId,
      name: serviceData.name,
      description: serviceData.description || '',
      capabilities: serviceData.capabilities,
      category: serviceData.category || 'general',
      price: serviceData.price || 0,
      currency: serviceData.currency || 'NGEN',
      tags: serviceData.tags || [],
      sla: serviceData.sla || { maxResponseTime: 3600000, availability: 0.99 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + SERVICE_LISTING_TTL,
      status: 'active',
      metadata: serviceData.metadata || {}
    };

    this.listings.set(listingId, listing);
    this.categories.add(listing.category);
    this._saveData();
    this.eventEmitter.emit('serviceListed', listing);

    return { success: true, listingId, listing };
  }

  updateListing(listingId, updates) {
    const listing = this.listings.get(listingId);
    if (!listing) {
      return { success: false, reason: 'Listing not found' };
    }

    const allowedFields = ['name', 'description', 'capabilities', 'category', 'price', 'currency', 'tags', 'sla', 'metadata'];
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        listing[key] = value;
      }
    }
    listing.updatedAt = Date.now();
    this.categories.add(listing.category);
    this._saveData();

    return { success: true, listing };
  }

  deactivateListing(listingId) {
    const listing = this.listings.get(listingId);
    if (!listing) {
      return { success: false, reason: 'Listing not found' };
    }
    listing.status = 'inactive';
    listing.updatedAt = Date.now();
    this._saveData();
    this.eventEmitter.emit('listingDeactivated', listing);
    return { success: true };
  }

  activateListing(listingId) {
    const listing = this.listings.get(listingId);
    if (!listing) {
      return { success: false, reason: 'Listing not found' };
    }
    listing.status = 'active';
    listing.expiresAt = Date.now() + SERVICE_LISTING_TTL;
    listing.updatedAt = Date.now();
    this._saveData();
    this.eventEmitter.emit('listingActivated', listing);
    return { success: true };
  }

  getListing(listingId) {
    return this.listings.get(listingId) || null;
  }

  searchListings(filters = {}) {
    let results = [];

    for (const listing of this.listings.values()) {
      if (listing.status !== 'active') continue;
      if (listing.expiresAt < Date.now()) continue;

      if (filters.category && listing.category !== filters.category) continue;

      if (filters.capabilities && filters.capabilities.length > 0) {
        const listingCaps = new Set(listing.capabilities.map(c => c.toLowerCase().trim()));
        const match = filters.capabilities.some(c => listingCaps.has(c.toLowerCase().trim()));
        if (!match) continue;
      }

      if (filters.maxPrice !== undefined && listing.price > filters.maxPrice) continue;
      if (filters.minPrice !== undefined && listing.price < filters.minPrice) continue;

      if (filters.currency && listing.currency !== filters.currency) continue;

      if (filters.tags && filters.tags.length > 0) {
        const listingTags = new Set(listing.tags.map(t => t.toLowerCase().trim()));
        const match = filters.tags.some(t => listingTags.has(t.toLowerCase().trim()));
        if (!match) continue;
      }

      if (filters.textQuery) {
        const query = filters.textQuery.toLowerCase();
        const searchText = `${listing.name} ${listing.description} ${listing.tags.join(' ')}`.toLowerCase();
        if (!searchText.includes(query)) continue;
      }

      const agentRating = this.getAgentRatingSummary(listing.agentId);
      results.push({
        ...listing,
        agentRating: agentRating.averageRating,
        agentReviewCount: agentRating.totalReviews,
        agentReputation: agentRating.reputation
      });
    }

    if (filters.sortBy === 'price_asc') {
      results.sort((a, b) => a.price - b.price);
    } else if (filters.sortBy === 'price_desc') {
      results.sort((a, b) => b.price - a.price);
    } else if (filters.sortBy === 'rating') {
      results.sort((a, b) => b.agentRating - a.agentRating);
    } else if (filters.sortBy === 'newest') {
      results.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      results.sort((a, b) => {
        const scoreA = a.agentRating * 20 + (a.agentReputation || 0);
        const scoreB = b.agentRating * 20 + (b.agentReputation || 0);
        return scoreB - scoreA;
      });
    }

    return results.slice(0, filters.limit || 100);
  }

  addReview(listingId, reviewerId, reviewData) {
    if (!listingId || !reviewerId) {
      return { success: false, reason: 'listingId and reviewerId are required' };
    }

    const listing = this.listings.get(listingId);
    if (!listing) {
      return { success: false, reason: 'Listing not found' };
    }

    if (reviewerId === listing.agentId) {
      return { success: false, reason: 'Cannot review your own listing' };
    }

    if (reviewData.rating < MIN_RATING || reviewData.rating > MAX_RATING) {
      return { success: false, reason: `Rating must be between ${MIN_RATING} and ${MAX_RATING}` };
    }

    if (reviewData.content && reviewData.content.length > MAX_REVIEW_LENGTH) {
      return { success: false, reason: `Review content must be under ${MAX_REVIEW_LENGTH} characters` };
    }

    const existingReviews = this.reviews.get(listingId) || [];
    const recentReview = existingReviews.find(r =>
      r.reviewerId === reviewerId && (Date.now() - r.createdAt) < REVIEW_COOLDOWN_MS
    );
    if (recentReview) {
      return { success: false, reason: 'Please wait before submitting another review' };
    }

    const reviewId = crypto.randomUUID();
    const review = {
      id: reviewId,
      listingId,
      agentId: listing.agentId,
      reviewerId,
      rating: reviewData.rating,
      title: reviewData.title || '',
      content: reviewData.content || '',
      createdAt: Date.now(),
      helpfulCount: 0,
      flags: []
    };

    if (!this.reviews.has(listingId)) {
      this.reviews.set(listingId, []);
    }
    this.reviews.get(listingId).push(review);

    this._updateAgentRating(listing.agentId);
    this._saveData();
    this.eventEmitter.emit('reviewAdded', review);

    return { success: true, reviewId, review };
  }

  markReviewHelpful(listingId, reviewId) {
    const reviews = this.reviews.get(listingId);
    if (!reviews) return { success: false, reason: 'Listing not found' };

    const review = reviews.find(r => r.id === reviewId);
    if (!review) return { success: false, reason: 'Review not found' };

    review.helpfulCount++;
    this._saveData();
    return { success: true, helpfulCount: review.helpfulCount };
  }

  flagReview(listingId, reviewId, reason) {
    const reviews = this.reviews.get(listingId);
    if (!reviews) return { success: false, reason: 'Listing not found' };

    const review = reviews.find(r => r.id === reviewId);
    if (!review) return { success: false, reason: 'Review not found' };

    review.flags.push({ reason, timestamp: Date.now() });
    this._saveData();
    return { success: true };
  }

  getReviews(listingId, options = {}) {
    const reviews = this.reviews.get(listingId) || [];
    let result = [...reviews];

    if (options.sortBy === 'newest') {
      result.sort((a, b) => b.createdAt - a.createdAt);
    } else if (options.sortBy === 'helpful') {
      result.sort((a, b) => b.helpfulCount - a.helpfulCount);
    } else if (options.sortBy === 'rating_high') {
      result.sort((a, b) => b.rating - a.rating);
    } else if (options.sortBy === 'rating_low') {
      result.sort((a, b) => a.rating - b.rating);
    }

    return result.slice(0, options.limit || 50);
  }

  getAgentReviews(agentId, options = {}) {
    const result = [];
    for (const [listingId, reviews] of this.reviews) {
      for (const review of reviews) {
        if (review.agentId === agentId) {
          result.push({ listingId, ...review });
        }
      }
    }

    if (options.sortBy === 'newest') {
      result.sort((a, b) => b.createdAt - a.createdAt);
    }

    return result.slice(0, options.limit || 50);
  }

  _updateAgentRating(agentId) {
    const allRatings = [];
    for (const [, reviews] of this.reviews) {
      for (const review of reviews) {
        if (review.agentId === agentId) {
          allRatings.push(review.rating);
        }
      }
    }

    if (allRatings.length === 0) return;

    const average = allRatings.reduce((sum, r) => sum + r, 0) / allRatings.length;
    const distribution = {};
    for (let i = MIN_RATING; i <= MAX_RATING; i++) {
      distribution[i] = allRatings.filter(r => r === i).length;
    }

    const recentRatings = allRatings.slice(-10);
    const recentAverage = recentRatings.reduce((sum, r) => sum + r, 0) / recentRatings.length;

    this.ratings.set(agentId, {
      averageRating: Math.round(average * 100) / 100,
      recentAverage: Math.round(recentAverage * 100) / 100,
      totalReviews: allRatings.length,
      distribution,
      updatedAt: Date.now()
    });
  }

  getAgentRatingSummary(agentId) {
    const rating = this.ratings.get(agentId);
    const agent = this.agentManager?.getAllAgents?.()
      ?.find(a => a.id === agentId);

    return {
      agentId,
      averageRating: rating?.averageRating || 0,
      recentAverage: rating?.recentAverage || 0,
      totalReviews: rating?.totalReviews || 0,
      distribution: rating?.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      reputation: agent?.reputation || 0
    };
  }

  recordTransaction(listingId, consumerId, transactionData = {}) {
    const listing = this.listings.get(listingId);
    if (!listing) {
      return { success: false, reason: 'Listing not found' };
    }

    if (listing.status !== 'active') {
      return { success: false, reason: 'Listing is not active' };
    }

    const amount = Number(transactionData.amount ?? listing.price ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, reason: 'amount must be a positive number', errorCode: 'INVALID_AMOUNT' };
    }

    const consumerWallet = transactionData.consumerWallet || null;
    const sellerWallet = transactionData.sellerWallet || null;

    // P1 NGEN escrow: if both wallets and blockchain state are available,
    // lock funds from buyer → escrow. Without wallets we fall back to the
    // legacy bookkeeping path (no on-chain movement).
    let escrowed = false;
    const state = this._getState();
    if (state && consumerWallet && sellerWallet && listing.currency === 'NGEN') {
      try {
        const amountBigInt = BigInt(Math.floor(amount));
        const buyerBalance = BigInt(state.getBalance(consumerWallet));
        if (buyerBalance < amountBigInt) {
          return {
            success: false,
            reason: `Insufficient balance: need ${amountBigInt.toString()} NGEN, have ${buyerBalance.toString()}`,
            errorCode: 'INSUFFICIENT_BALANCE'
          };
        }
        state.subtractBalance(consumerWallet, amountBigInt.toString());
        state.addBalance(ESCROW_ADDR, amountBigInt.toString());
        escrowed = true;
        console.log(`[AgentMarketplace] Escrowed: ${amountBigInt.toString()} NGEN from ${consumerWallet.slice(0, 12)}... → escrow (listing ${listingId.slice(0, 8)})`);
      } catch (e) {
        console.error(`[AgentMarketplace] Escrow failed:`, e.message);
        return { success: false, reason: `Escrow failed: ${e.message}`, errorCode: 'ESCROW_FAILED' };
      }
    }

    const transactionId = crypto.randomUUID();
    const transaction = {
      id: transactionId,
      listingId,
      agentId: listing.agentId,
      consumerId,
      consumerWallet: consumerWallet || null,
      sellerWallet: sellerWallet || null,
      amount,
      currency: listing.currency,
      status: 'pending',
      escrowed,
      createdAt: Date.now(),
      completedAt: null,
      metadata: transactionData.metadata || {}
    };

    this.transactions.set(transactionId, transaction);
    this._saveTransactions();
    this.eventEmitter.emit('transactionCreated', transaction);

    return { success: true, transactionId, transaction };
  }

  completeTransaction(transactionId) {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, reason: 'Transaction not found' };
    }
    if (transaction.status !== 'pending') {
      return { success: false, reason: `Transaction already ${transaction.status}` };
    }

    // P1 escrow release: funds flow from escrow → seller wallet
    const state = this._getState();
    if (transaction.escrowed && state && transaction.sellerWallet) {
      try {
        const amountBigInt = BigInt(Math.floor(transaction.amount));
        state.subtractBalance(ESCROW_ADDR, amountBigInt.toString());
        state.addBalance(transaction.sellerWallet, amountBigInt.toString());
        console.log(`[AgentMarketplace] Escrow released: ${amountBigInt.toString()} NGEN → ${transaction.sellerWallet.slice(0, 12)}... (tx ${transactionId.slice(0, 8)})`);
      } catch (e) {
        console.error(`[AgentMarketplace] Release failed:`, e.message);
        return { success: false, reason: `Release failed: ${e.message}`, errorCode: 'RELEASE_FAILED' };
      }
    }

    transaction.status = 'completed';
    transaction.completedAt = Date.now();
    this._saveTransactions();
    this.eventEmitter.emit('transactionCompleted', transaction);

    return { success: true, transaction };
  }

  cancelTransaction(transactionId, reason = 'cancelled') {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, reason: 'Transaction not found' };
    }
    if (transaction.status !== 'pending') {
      return { success: false, reason: `Transaction already ${transaction.status}` };
    }

    // P1 escrow refund: funds flow from escrow → buyer wallet
    const state = this._getState();
    if (transaction.escrowed && state && transaction.consumerWallet) {
      try {
        const amountBigInt = BigInt(Math.floor(transaction.amount));
        state.subtractBalance(ESCROW_ADDR, amountBigInt.toString());
        state.addBalance(transaction.consumerWallet, amountBigInt.toString());
        console.log(`[AgentMarketplace] Escrow refunded: ${amountBigInt.toString()} NGEN → ${transaction.consumerWallet.slice(0, 12)}... (reason: ${reason})`);
      } catch (e) {
        console.error(`[AgentMarketplace] Refund failed:`, e.message);
      }
    }

    transaction.status = 'cancelled';
    transaction.cancelledAt = Date.now();
    transaction.cancelReason = reason;
    this._saveTransactions();
    this.eventEmitter.emit('transactionCancelled', transaction);

    return { success: true, transaction };
  }

  _saveTransactions() {
    try {
      const txObj = Object.fromEntries(this.transactions);
      fs.writeFileSync(
        path.join(MARKETPLACE_DATA_DIR, 'transactions.json'),
        JSON.stringify(txObj, null, 2)
      );
    } catch (e) { /* ignore */ }
  }

  _saveSubscriptions() {
    try {
      const subsObj = Object.fromEntries(this.subscriptions);
      fs.writeFileSync(
        path.join(MARKETPLACE_DATA_DIR, 'subscriptions.json'),
        JSON.stringify(subsObj, null, 2)
      );
    } catch (e) { /* ignore */ }

    try {
      const payObj = Object.fromEntries(this.subscriptionPayments);
      fs.writeFileSync(
        path.join(MARKETPLACE_DATA_DIR, 'subscription_payments.json'),
        JSON.stringify(payObj, null, 2)
      );
    } catch (e) { /* ignore */ }
  }

  // Resolve an agent's on-chain wallet address. Primary path is the direct
  // registry lookup `state.agentRegistry.agents.get(agentId).address`; we
  // fall back to scanning by agent_id/identity/address so subscriptions
  // remain usable for agents registered under any key shape.
  _resolveAgentWallet(agentId) {
    const state = this._getState();
    if (!state?.agentRegistry?.agents) return null;

    const direct = state.agentRegistry.agents.get(agentId);
    if (direct?.address) return direct.address;

    const agents = state.agentRegistry.agents instanceof Map
      ? Array.from(state.agentRegistry.agents.values())
      : [];
    const record = agents.find(a =>
      a.agent_id === agentId || a.identity === agentId || a.address === agentId
    );
    return record?.address || null;
  }

  // ─── P4 Subscription stream ───
  // Agent publishes a recurring service plan; consumers pay NGEN per cycle.

  createSubscription(agentId, subData) {
    if (!agentId) {
      return { success: false, reason: 'agentId is required' };
    }
    if (!subData || !subData.title) {
      return { success: false, reason: 'title is required' };
    }
    if (!subData.capabilities || !Array.isArray(subData.capabilities) || subData.capabilities.length === 0) {
      return { success: false, reason: 'At least one capability is required' };
    }

    const pricePerCycle = Math.floor(Number(subData.pricePerCycle));
    if (!Number.isFinite(pricePerCycle) || pricePerCycle <= 0) {
      return { success: false, reason: 'pricePerCycle must be a positive integer' };
    }

    const cycleDurationMs = Math.floor(Number(subData.cycleDurationMs));
    if (!Number.isFinite(cycleDurationMs) || cycleDurationMs <= 0) {
      return { success: false, reason: 'cycleDurationMs must be a positive integer' };
    }

    const maxSubscribers = subData.maxSubscribers === undefined || subData.maxSubscribers === null
      ? null
      : Math.floor(Number(subData.maxSubscribers));
    if (maxSubscribers !== null && (!Number.isFinite(maxSubscribers) || maxSubscribers < 0)) {
      return { success: false, reason: 'maxSubscribers must be a non-negative integer or null' };
    }

    const subscriptionId = crypto.randomUUID();
    const now = Date.now();
    const subscription = {
      id: subscriptionId,
      agentId,
      title: subData.title,
      description: subData.description || '',
      capabilities: subData.capabilities,
      pricePerCycle,
      cycleDurationMs,
      maxSubscribers,
      currency: 'NGEN',
      status: 'active',          // plan status: active | inactive
      subscriberCount: 0,
      subscribers: {},           // consumerId -> subscriber instance
      createdAt: now,
      updatedAt: now,
      metadata: subData.metadata || {}
    };

    this.subscriptions.set(subscriptionId, subscription);
    this._saveSubscriptions();
    this.eventEmitter.emit('subscriptionCreated', subscription);

    return { success: true, subscriptionId, subscription };
  }

  subscribe(subscriptionId, consumerId, consumerWallet) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return { success: false, reason: 'Subscription not found' };
    }
    if (subscription.status !== 'active') {
      return { success: false, reason: `Subscription plan is ${subscription.status}` };
    }
    if (!consumerId || !consumerWallet) {
      return { success: false, reason: 'consumerId and consumerWallet are required' };
    }

    const existing = subscription.subscribers[consumerId];
    if (existing && existing.status === 'active') {
      return { success: false, reason: 'Consumer already subscribed', errorCode: 'ALREADY_SUBSCRIBED' };
    }
    if (existing && existing.status === 'cancelled') {
      return { success: false, reason: 'Consumer previously cancelled; re-subscribe not allowed', errorCode: 'ALREADY_CANCELLED' };
    }

    if (subscription.maxSubscribers !== null &&
        subscription.subscriberCount >= subscription.maxSubscribers) {
      return { success: false, reason: 'Subscription plan is full', errorCode: 'MAX_SUBSCRIBERS' };
    }

    const state = this._getState();
    if (!state) {
      return { success: false, reason: 'Blockchain state not available', errorCode: 'STATE_UNAVAILABLE' };
    }

    const agentWallet = this._resolveAgentWallet(subscription.agentId);
    if (!agentWallet) {
      return { success: false, reason: `Agent wallet not found for ${subscription.agentId}`, errorCode: 'AGENT_WALLET_NOT_FOUND' };
    }

    // Charge first cycle: consumer → agent (direct transfer, no escrow)
    const amountBigInt = BigInt(subscription.pricePerCycle);
    const consumerBalance = BigInt(state.getBalance(consumerWallet));
    if (consumerBalance < amountBigInt) {
      return {
        success: false,
        reason: `Insufficient balance: need ${amountBigInt.toString()} NGEN, have ${consumerBalance.toString()}`,
        errorCode: 'INSUFFICIENT_BALANCE'
      };
    }

    try {
      state.subtractBalance(consumerWallet, amountBigInt.toString());
      state.addBalance(agentWallet, amountBigInt.toString());
    } catch (e) {
      console.error('[AgentMarketplace] Subscription initial charge failed:', e.message);
      return { success: false, reason: `Charge failed: ${e.message}`, errorCode: 'CHARGE_FAILED' };
    }

    const now = Date.now();
    const subscriber = {
      consumerId,
      consumerWallet,
      agentWallet,
      status: 'active',          // active | suspended | cancelled
      startedAt: now,
      nextPaymentAt: now + subscription.cycleDurationMs,
      lastPaymentAt: now,
      totalPaidCycles: 1,
      cancelledAt: null
    };

    subscription.subscribers[consumerId] = subscriber;
    subscription.subscriberCount += 1;
    subscription.updatedAt = now;
    this._saveSubscriptions();

    // Record first-cycle payment
    const paymentId = crypto.randomUUID();
    const payment = {
      id: paymentId,
      subscriptionId,
      agentId: subscription.agentId,
      consumerId,
      consumerWallet,
      agentWallet,
      amount: subscription.pricePerCycle,
      currency: 'NGEN',
      cycle: 1,
      status: 'paid',
      reason: 'initial',
      createdAt: now
    };
    this.subscriptionPayments.set(paymentId, payment);
    this._saveSubscriptions();

    console.log(`[AgentMarketplace] Subscription ${subscriptionId.slice(0, 8)}: ${amountBigInt.toString()} NGEN ${consumerWallet.slice(0, 12)}... → ${agentWallet.slice(0, 12)}... (cycle 1)`);
    this.eventEmitter.emit('subscriptionSubscribed', { subscription, subscriber, payment });

    return { success: true, subscriptionId, subscriber, payment };
  }

  processCyclePayment(subscriptionId, consumerId) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return { success: false, reason: 'Subscription not found' };
    }

    const subscriber = subscription.subscribers[consumerId];
    if (!subscriber) {
      return { success: false, reason: 'Consumer is not subscribed to this plan' };
    }
    if (subscriber.status === 'cancelled') {
      return { success: false, reason: 'Subscription is cancelled', errorCode: 'CANCELLED' };
    }

    const now = Date.now();
    // Due check: active subscriptions must wait until nextPaymentAt.
    // Suspended subscriptions may retry early (e.g. after a top-up).
    if (subscriber.status === 'active' && subscriber.nextPaymentAt > now) {
      return {
        success: false,
        reason: 'Cycle not due yet',
        errorCode: 'NOT_DUE',
        nextPaymentAt: subscriber.nextPaymentAt,
        now
      };
    }

    const state = this._getState();
    if (!state) {
      return { success: false, reason: 'Blockchain state not available', errorCode: 'STATE_UNAVAILABLE' };
    }

    const amountBigInt = BigInt(subscription.pricePerCycle);
    const consumerBalance = BigInt(state.getBalance(subscriber.consumerWallet));
    const cycleNumber = subscriber.totalPaidCycles + 1;

    if (consumerBalance < amountBigInt) {
      // Insufficient funds: suspend, do NOT auto-cancel. nextPaymentAt is
      // left in the past so a manual retry can attempt to reactivate.
      subscriber.status = 'suspended';
      subscription.updatedAt = now;

      const failPaymentId = crypto.randomUUID();
      const failPayment = {
        id: failPaymentId,
        subscriptionId,
        agentId: subscription.agentId,
        consumerId,
        consumerWallet: subscriber.consumerWallet,
        agentWallet: subscriber.agentWallet,
        amount: subscription.pricePerCycle,
        currency: 'NGEN',
        cycle: cycleNumber,
        status: 'failed',
        reason: `Insufficient balance: need ${amountBigInt.toString()}, have ${consumerBalance.toString()}`,
        createdAt: now
      };
      this.subscriptionPayments.set(failPaymentId, failPayment);
      this._saveSubscriptions();

      console.log(`[AgentMarketplace] Subscription ${subscriptionId.slice(0, 8)} SUSPENDED: ${subscriber.consumerWallet.slice(0, 12)}... (need ${amountBigInt.toString()}, have ${consumerBalance.toString()})`);
      this.eventEmitter.emit('subscriptionSuspended', { subscription, subscriber, payment: failPayment });

      return {
        success: false,
        reason: `Insufficient balance: need ${amountBigInt.toString()} NGEN, have ${consumerBalance.toString()}`,
        errorCode: 'INSUFFICIENT_BALANCE',
        status: 'suspended'
      };
    }

    // Charge cycle: consumer → agent
    try {
      state.subtractBalance(subscriber.consumerWallet, amountBigInt.toString());
      state.addBalance(subscriber.agentWallet, amountBigInt.toString());
    } catch (e) {
      console.error('[AgentMarketplace] Subscription cycle charge failed:', e.message);
      return { success: false, reason: `Charge failed: ${e.message}`, errorCode: 'CHARGE_FAILED' };
    }

    subscriber.status = 'active';
    subscriber.lastPaymentAt = now;
    subscriber.nextPaymentAt = now + subscription.cycleDurationMs;
    subscriber.totalPaidCycles = cycleNumber;
    subscription.updatedAt = now;

    const paymentId = crypto.randomUUID();
    const payment = {
      id: paymentId,
      subscriptionId,
      agentId: subscription.agentId,
      consumerId,
      consumerWallet: subscriber.consumerWallet,
      agentWallet: subscriber.agentWallet,
      amount: subscription.pricePerCycle,
      currency: 'NGEN',
      cycle: cycleNumber,
      status: 'paid',
      reason: 'cycle',
      createdAt: now
    };
    this.subscriptionPayments.set(paymentId, payment);
    this._saveSubscriptions();

    console.log(`[AgentMarketplace] Subscription ${subscriptionId.slice(0, 8)}: ${amountBigInt.toString()} NGEN ${subscriber.consumerWallet.slice(0, 12)}... → ${subscriber.agentWallet.slice(0, 12)}... (cycle ${cycleNumber})`);
    this.eventEmitter.emit('subscriptionCyclePaid', { subscription, subscriber, payment });

    return { success: true, subscriptionId, subscriber, payment };
  }

  cancelSubscription(subscriptionId, consumerId) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return { success: false, reason: 'Subscription not found' };
    }

    const subscriber = subscription.subscribers[consumerId];
    if (!subscriber) {
      return { success: false, reason: 'Consumer is not subscribed to this plan' };
    }
    if (subscriber.status === 'cancelled') {
      return { success: false, reason: 'Subscription already cancelled', errorCode: 'ALREADY_CANCELLED' };
    }

    const now = Date.now();
    const previousStatus = subscriber.status;
    subscriber.status = 'cancelled';
    subscriber.cancelledAt = now;
    // Only decrement the active count if this subscriber was active/suspended
    // (i.e. counted) before cancellation.
    if (previousStatus === 'active' || previousStatus === 'suspended') {
      subscription.subscriberCount = Math.max(0, subscription.subscriberCount - 1);
    }
    subscription.updatedAt = now;
    this._saveSubscriptions();

    this.eventEmitter.emit('subscriptionCancelled', { subscription, subscriber });

    return { success: true, subscriptionId, subscriber };
  }

  getSubscription(subscriptionId) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    return subscription;
  }

  listSubscriptions(filter = {}) {
    let results = [];
    for (const subscription of this.subscriptions.values()) {
      if (filter.agentId && subscription.agentId !== filter.agentId) continue;
      if (filter.status && subscription.status !== filter.status) continue;
      results.push({
        id: subscription.id,
        agentId: subscription.agentId,
        title: subscription.title,
        description: subscription.description,
        capabilities: subscription.capabilities,
        pricePerCycle: subscription.pricePerCycle,
        cycleDurationMs: subscription.cycleDurationMs,
        maxSubscribers: subscription.maxSubscribers,
        currency: subscription.currency,
        status: subscription.status,
        subscriberCount: subscription.subscriberCount,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt
      });
    }

    results.sort((a, b) => b.createdAt - a.createdAt);
    const limit = filter.limit ? parseInt(filter.limit, 10) : 100;
    return results.slice(0, limit);
  }

  getConsumerSubscriptions(consumerId) {
    const result = [];
    for (const subscription of this.subscriptions.values()) {
      const subscriber = subscription.subscribers[consumerId];
      if (!subscriber) continue;
      result.push({
        subscription: {
          id: subscription.id,
          agentId: subscription.agentId,
          title: subscription.title,
          description: subscription.description,
          capabilities: subscription.capabilities,
          pricePerCycle: subscription.pricePerCycle,
          cycleDurationMs: subscription.cycleDurationMs,
          currency: subscription.currency,
          status: subscription.status
        },
        subscriber
      });
    }
    result.sort((a, b) => b.subscriber.startedAt - a.subscriber.startedAt);
    return result;
  }

  getAgentListings(agentId) {
    const result = [];
    for (const listing of this.listings.values()) {
      if (listing.agentId === agentId) {
        result.push(listing);
      }
    }
    return result;
  }

  getCategories() {
    return Array.from(this.categories).sort();
  }

  getMarketplaceStats() {
    const activeListings = Array.from(this.listings.values()).filter(
      l => l.status === 'active' && l.expiresAt > Date.now()
    );

    const totalReviews = Array.from(this.reviews.values()).reduce((sum, r) => sum + r.length, 0);
    const totalTransactions = this.transactions.size;
    const completedTransactions = Array.from(this.transactions.values()).filter(t => t.status === 'completed').length;

    let totalVolume = 0;
    for (const tx of this.transactions.values()) {
      if (tx.status === 'completed') totalVolume += tx.amount;
    }

    let averageRating = 0;
    const allRatings = Array.from(this.ratings.values());
    if (allRatings.length > 0) {
      averageRating = allRatings.reduce((sum, r) => sum + r.averageRating, 0) / allRatings.length;
    }

    const categoryStats = {};
    for (const listing of this.listings.values()) {
      if (listing.status !== 'active') continue;
      if (!categoryStats[listing.category]) {
        categoryStats[listing.category] = { count: 0, totalVolume: 0 };
      }
      categoryStats[listing.category].count++;
    }

    const topRatedAgents = Array.from(this.ratings.entries())
      .sort((a, b) => b[1].averageRating - a[1].averageRating)
      .slice(0, 10)
      .map(([agentId, rating]) => ({ agentId, ...rating }));

    return {
      totalListings: this.listings.size,
      activeListings: activeListings.length,
      categories: this.categories.size,
      totalReviews,
      totalTransactions,
      completedTransactions,
      totalVolume,
      averageRating: Math.round(averageRating * 100) / 100,
      categoryStats,
      topRatedAgents
    };
  }

  cleanupExpiredListings() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, listing] of this.listings) {
      if (listing.expiresAt < now && listing.status === 'active') {
        listing.status = 'expired';
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this._saveData();
    }
    return cleaned;
  }

  // ─── P4 NGEN sink: competitive auction escrow ───
  // External user publishes a demand with a locked NGEN reward; multiple
  // agents bid (bidAmount = NGEN they'll accept, must be <= rewardNGEN);
  // publisher picks the winner; escrow pays the winner and refunds the
  // difference to the publisher. Cancel refunds the full reward.

  _saveAuctions() {
    try {
      const auctionsObj = Object.fromEntries(this.auctions);
      fs.writeFileSync(
        path.join(MARKETPLACE_DATA_DIR, 'auctions.json'),
        JSON.stringify(auctionsObj, null, 2)
      );
    } catch (e) { /* ignore */ }
  }

  createAuction(publisherId, auctionData) {
    if (!publisherId) {
      return { success: false, reason: 'publisherId is required' };
    }
    if (!auctionData || !auctionData.title || auctionData.rewardNGEN === undefined) {
      return { success: false, reason: 'title and rewardNGEN are required' };
    }

    const rewardNGEN = Math.floor(Number(auctionData.rewardNGEN));
    if (!Number.isFinite(rewardNGEN) || rewardNGEN <= 0) {
      return { success: false, reason: 'rewardNGEN must be a positive number', errorCode: 'INVALID_AMOUNT' };
    }

    const publisherWallet = auctionData.publisherWallet || null;
    const deadline = auctionData.deadline ? Number(auctionData.deadline) : (Date.now() + 7 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      return { success: false, reason: 'deadline must be a future timestamp' };
    }

    // P4 NGEN escrow: lock reward from publisher → escrow
    let escrowed = false;
    const state = this._getState();
    if (state && publisherWallet) {
      try {
        const amountBigInt = BigInt(rewardNGEN);
        const publisherBalance = BigInt(state.getBalance(publisherWallet));
        if (publisherBalance < amountBigInt) {
          return {
            success: false,
            reason: `Insufficient balance: need ${amountBigInt.toString()} NGEN, have ${publisherBalance.toString()}`,
            errorCode: 'INSUFFICIENT_BALANCE'
          };
        }
        state.subtractBalance(publisherWallet, amountBigInt.toString());
        state.addBalance(ESCROW_ADDR, amountBigInt.toString());
        escrowed = true;
        console.log(`[AgentMarketplace] Auction escrowed: ${amountBigInt.toString()} NGEN from ${publisherWallet.slice(0, 12)}... → escrow`);
      } catch (e) {
        console.error(`[AgentMarketplace] Auction escrow failed:`, e.message);
        return { success: false, reason: `Escrow failed: ${e.message}`, errorCode: 'ESCROW_FAILED' };
      }
    }

    const auctionId = crypto.randomUUID();
    const auction = {
      id: auctionId,
      publisherId,
      publisherWallet: publisherWallet || null,
      title: auctionData.title,
      description: auctionData.description || '',
      requirements: auctionData.requirements || {},
      rewardNGEN,
      deadline,
      status: 'open',
      escrowed,
      bids: [],
      winnerBidId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      closedAt: null,
      cancelledAt: null,
      cancelReason: null,
      metadata: auctionData.metadata || {}
    };

    this.auctions.set(auctionId, auction);
    this._saveAuctions();
    this.eventEmitter.emit('auctionCreated', auction);

    return { success: true, auctionId, auction };
  }

  placeBid(auctionId, bidderId, bidAmount, proposal) {
    const auction = this.auctions.get(auctionId);
    if (!auction) {
      return { success: false, reason: 'Auction not found' };
    }
    if (auction.status !== 'open' && auction.status !== 'bidding') {
      return { success: false, reason: `Auction is ${auction.status}, cannot accept bids` };
    }
    if (Date.now() > auction.deadline) {
      return { success: false, reason: 'Auction deadline has passed' };
    }
    if (!bidderId) {
      return { success: false, reason: 'bidderId is required' };
    }
    if (bidderId === auction.publisherId) {
      return { success: false, reason: 'Publisher cannot bid on their own auction' };
    }

    const amount = Math.floor(Number(bidAmount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, reason: 'bidAmount must be a positive number', errorCode: 'INVALID_AMOUNT' };
    }
    if (amount > auction.rewardNGEN) {
      return {
        success: false,
        reason: `bidAmount (${amount}) cannot exceed rewardNGEN (${auction.rewardNGEN})`,
        errorCode: 'BID_EXCEEDS_REWARD'
      };
    }

    // proposal may be a string (proposal text) or an object carrying
    // { text, bidderWallet, metadata }. The HTTP layer injects the wallet
    // resolved from the on-chain agent registry so escrow can be settled.
    let proposalText = '';
    let bidderWallet = null;
    let metadata = {};
    if (typeof proposal === 'string') {
      proposalText = proposal;
    } else if (proposal && typeof proposal === 'object') {
      proposalText = proposal.text || proposal.proposal || '';
      bidderWallet = proposal.bidderWallet || proposal.wallet || null;
      metadata = proposal.metadata || {};
    }

    const bidId = crypto.randomUUID();
    const bid = {
      id: bidId,
      auctionId,
      bidderId,
      bidderWallet,
      bidAmount: amount,
      proposal: proposalText,
      metadata,
      createdAt: Date.now(),
      status: 'pending'
    };

    auction.bids.push(bid);
    if (auction.status === 'open') {
      auction.status = 'bidding';
    }
    auction.updatedAt = Date.now();
    this._saveAuctions();
    this.eventEmitter.emit('bidPlaced', { auction, bid });

    return { success: true, bidId, bid };
  }

  closeAuction(auctionId, winnerBidId, publisherId) {
    const auction = this.auctions.get(auctionId);
    if (!auction) {
      return { success: false, reason: 'Auction not found' };
    }
    if (publisherId && auction.publisherId !== publisherId) {
      return { success: false, reason: 'Only the publisher can close this auction', errorCode: 'NOT_AUTHORIZED' };
    }
    if (auction.status !== 'open' && auction.status !== 'bidding') {
      return { success: false, reason: `Auction is ${auction.status}, cannot close` };
    }
    const winnerBid = auction.bids.find(b => b.id === winnerBidId);
    if (!winnerBid) {
      return { success: false, reason: 'Winning bid not found', errorCode: 'BID_NOT_FOUND' };
    }

    // P4 escrow settlement: pay winner their bid, refund remainder to publisher
    const state = this._getState();
    if (auction.escrowed && state) {
      try {
        const rewardBigInt = BigInt(auction.rewardNGEN);
        const bidBigInt = BigInt(winnerBid.bidAmount);
        if (winnerBid.bidderWallet) {
          state.subtractBalance(ESCROW_ADDR, bidBigInt.toString());
          state.addBalance(winnerBid.bidderWallet, bidBigInt.toString());
          console.log(`[AgentMarketplace] Auction payout: ${bidBigInt.toString()} NGEN → ${winnerBid.bidderWallet.slice(0, 12)}...`);
        }
        const refund = rewardBigInt - bidBigInt;
        if (refund > 0n && auction.publisherWallet) {
          state.subtractBalance(ESCROW_ADDR, refund.toString());
          state.addBalance(auction.publisherWallet, refund.toString());
          console.log(`[AgentMarketplace] Auction refund: ${refund.toString()} NGEN → ${auction.publisherWallet.slice(0, 12)}...`);
        }
      } catch (e) {
        console.error(`[AgentMarketplace] Auction settlement failed:`, e.message);
        return { success: false, reason: `Settlement failed: ${e.message}`, errorCode: 'SETTLEMENT_FAILED' };
      }
    }

    auction.status = 'awarded';
    auction.winnerBidId = winnerBidId;
    auction.closedAt = Date.now();
    auction.updatedAt = Date.now();
    for (const bid of auction.bids) {
      bid.status = bid.id === winnerBidId ? 'awarded' : 'rejected';
    }
    this._saveAuctions();
    this.eventEmitter.emit('auctionClosed', { auction, winnerBid });

    return { success: true, auction };
  }

  cancelAuction(auctionId, publisherId, reason = 'cancelled') {
    const auction = this.auctions.get(auctionId);
    if (!auction) {
      return { success: false, reason: 'Auction not found' };
    }
    if (publisherId && auction.publisherId !== publisherId) {
      return { success: false, reason: 'Only the publisher can cancel this auction', errorCode: 'NOT_AUTHORIZED' };
    }
    if (auction.status === 'awarded' || auction.status === 'cancelled') {
      return { success: false, reason: `Auction already ${auction.status}` };
    }

    // P4 escrow refund: full reward back to publisher
    const state = this._getState();
    if (auction.escrowed && state && auction.publisherWallet) {
      try {
        const amountBigInt = BigInt(auction.rewardNGEN);
        state.subtractBalance(ESCROW_ADDR, amountBigInt.toString());
        state.addBalance(auction.publisherWallet, amountBigInt.toString());
        console.log(`[AgentMarketplace] Auction cancelled, refunded: ${amountBigInt.toString()} NGEN → ${auction.publisherWallet.slice(0, 12)}...`);
      } catch (e) {
        console.error(`[AgentMarketplace] Auction refund failed:`, e.message);
        return { success: false, reason: `Refund failed: ${e.message}`, errorCode: 'REFUND_FAILED' };
      }
    }

    auction.status = 'cancelled';
    auction.cancelledAt = Date.now();
    auction.cancelReason = reason;
    auction.updatedAt = Date.now();
    this._saveAuctions();
    this.eventEmitter.emit('auctionCancelled', auction);

    return { success: true, auction };
  }

  getAuction(auctionId) {
    return this.auctions.get(auctionId) || null;
  }

  listAuctions(filter = {}) {
    let results = Array.from(this.auctions.values());
    if (filter.status) {
      results = results.filter(a => a.status === filter.status);
    }
    if (filter.publisherId) {
      results = results.filter(a => a.publisherId === filter.publisherId);
    }
    if (filter.bidderId) {
      results = results.filter(a => a.bids.some(b => b.bidderId === filter.bidderId));
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    const limit = filter.limit ? parseInt(filter.limit) : 100;
    return results.slice(0, limit);
  }
}

const agentMarketplace = new AgentMarketplace();
export { AgentMarketplace };
export default agentMarketplace;

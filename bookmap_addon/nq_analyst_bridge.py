"""
NQ Analyst Bridge — Bookmap Python Add-on
==========================================
Streams live order flow data from Bookmap (CME feed) to the NQ Analyst
dashboard webhook every bar close.

INSTALL:
  1. In Bookmap → Settings → Manage Plugins → Add-ons (L1)
  2. Click "+" → select this file
  3. Set WEBHOOK_URL below to your deployed app URL

REQUIREMENTS:
  - Bookmap 7.4+ with Python Add-on plugin enabled
  - Python 3.7+ (bundled with Bookmap)
  - 'requests' library (pip install requests, or Bookmap's bundled pip)

DATA SENT (merged with your TradingView Pine Script payload format):
  - bid_stack_size    : total bid qty within BID_DEPTH pts of best bid
  - ask_stack_size    : total ask qty within ASK_DEPTH pts of best ask
  - delta             : cumulative (buy vol - sell vol) for current bar
  - buy_volume        : aggressive buy volume this bar
  - sell_volume       : aggressive sell volume this bar
  - large_trade_count : prints >= LARGE_TRADE_SIZE contracts this bar
  - large_buy_count   : large prints on bid side
  - large_sell_count  : large prints on ask side
  - absorption_bull   : 1 if large sell met with held/growing bid (bull absorption)
  - absorption_bear   : 1 if large buy met with held/growing ask (bear absorption)
  - vap_poc           : price level with highest volume this bar (POC)
  - imbalance_bull    : 1 if bid stack > ask stack by IMBALANCE_RATIO
  - imbalance_bear    : 1 if ask stack > bid stack by IMBALANCE_RATIO
  - source            : "bookmap_cme"
"""

import threading
import time
import json
from collections import defaultdict

# ── Configuration ─────────────────────────────────────────────────────────────
WEBHOOK_URL     = "https://www.perplexity.ai/computer/a/nq-ai-quant-analyst-unOR7IDXTYKXpGN7vfu4Wg/api/webhook"
TICKER          = "NQ1!"
BAR_SECONDS     = 60         # Send data every N seconds (60 = 1-min bars)
BID_DEPTH       = 10         # Points below best bid to sum for bid stack
ASK_DEPTH       = 10         # Points above best ask to sum for ask stack
LARGE_TRADE_SIZE = 10        # Contracts — what counts as a "large" print
IMBALANCE_RATIO  = 2.0       # Ask/bid ratio threshold for imbalance flag

# ── Bookmap API imports (available inside Bookmap's Python runtime) ────────────
try:
    import bookmap as bm
except ImportError:
    # Running outside Bookmap for testing — mock the module
    import types
    bm = types.ModuleType("bookmap")
    bm.Module = object
    bm.EVENT_DEPTH  = "depth"
    bm.EVENT_TRADE  = "trade"
    bm.EVENT_MBOS   = "mbos"
    print("[NQ Bridge] WARNING: bookmap module not found — running in stub mode")

try:
    import requests
except ImportError:
    requests = None
    print("[NQ Bridge] WARNING: 'requests' not installed. Run: pip install requests")


# ── Bar state (resets every BAR_SECONDS) ──────────────────────────────────────
class BarState:
    def __init__(self):
        self.reset()

    def reset(self):
        self.buy_volume   = 0
        self.sell_volume  = 0
        self.large_trades = []       # list of (price, size, is_buy)
        self.vap          = defaultdict(int)  # price → volume
        self.bid_book     = {}       # price → size (current snapshot)
        self.ask_book     = {}
        self.best_bid     = 0.0
        self.best_ask     = 0.0
        self.prev_bid_at_best = 0    # for absorption detection
        self.prev_ask_at_best = 0
        self.absorption_bull = 0
        self.absorption_bear = 0

    def record_trade(self, price: float, size: int, is_buy: bool):
        if is_buy:
            self.buy_volume += size
        else:
            self.sell_volume += size
        self.vap[round(price, 2)] += size
        if size >= LARGE_TRADE_SIZE:
            self.large_trades.append((price, size, is_buy))
            # Absorption: large sell but bid held/grew = bull absorption
            if not is_buy and self.bid_book.get(self.best_bid, 0) >= self.prev_bid_at_best:
                self.absorption_bull = 1
            if is_buy and self.ask_book.get(self.best_ask, 0) >= self.prev_ask_at_best:
                self.absorption_bear = 1

    def update_depth(self, price: float, size: int, is_bid: bool):
        book = self.bid_book if is_bid else self.ask_book
        if size == 0:
            book.pop(price, None)
        else:
            book[price] = size
        if is_bid and book:
            new_best = max(book.keys())
            if new_best != self.best_bid:
                self.prev_bid_at_best = book.get(self.best_bid, 0)
                self.best_bid = new_best
        if not is_bid and book:
            new_best = min(book.keys())
            if new_best != self.best_ask:
                self.prev_ask_at_best = book.get(self.best_ask, 0)
                self.best_ask = new_best

    def bid_stack(self) -> int:
        if not self.best_bid:
            return 0
        return sum(
            v for p, v in self.bid_book.items()
            if self.best_bid - BID_DEPTH <= p <= self.best_bid
        )

    def ask_stack(self) -> int:
        if not self.best_ask:
            return 0
        return sum(
            v for p, v in self.ask_book.items()
            if self.best_ask <= p <= self.best_ask + ASK_DEPTH
        )

    def poc(self) -> float:
        if not self.vap:
            return 0.0
        return max(self.vap, key=self.vap.get)

    def to_payload(self) -> dict:
        delta      = self.buy_volume - self.sell_volume
        bid_sz     = self.bid_stack()
        ask_sz     = self.ask_stack()
        large_buys  = sum(1 for _, _, ib in self.large_trades if ib)
        large_sells = sum(1 for _, _, ib in self.large_trades if not ib)

        imbalance_bull = 1 if (ask_sz > 0 and bid_sz / max(ask_sz, 1) >= IMBALANCE_RATIO) else 0
        imbalance_bear = 1 if (bid_sz > 0 and ask_sz / max(bid_sz, 1) >= IMBALANCE_RATIO) else 0

        return {
            "ticker":            TICKER,
            "timeframe":         str(BAR_SECONDS // 60),  # minutes
            "source":            "bookmap_cme",
            # order flow
            "bid_stack_size":    bid_sz,
            "ask_stack_size":    ask_sz,
            "delta":             delta,
            "buy_volume":        self.buy_volume,
            "sell_volume":       self.sell_volume,
            "large_trade_count": len(self.large_trades),
            "large_buy_count":   large_buys,
            "large_sell_count":  large_sells,
            "absorption_bull":   self.absorption_bull,
            "absorption_bear":   self.absorption_bear,
            "vap_poc":           self.poc(),
            "imbalance_bull":    imbalance_bull,
            "imbalance_bear":    imbalance_bear,
            # price
            "close":             self.best_bid if self.best_bid else None,
            "vwap":              None,  # TradingView sends this separately
        }


# ── Bookmap Add-on class ───────────────────────────────────────────────────────
class NQAnalystBridge(bm.Module):

    def __init__(self):
        super().__init__()
        self.bar  = BarState()
        self.lock = threading.Lock()
        self._start_bar_timer()
        print("[NQ Bridge] Initialized — posting to:", WEBHOOK_URL)

    # ── Bookmap callbacks ────────────────────────────────────────────────────

    def on_depth(self, alias, is_bid, price, size):
        """Called on every order book update."""
        with self.lock:
            self.bar.update_depth(float(price), int(size), bool(is_bid))

    def on_trade(self, alias, price, size, is_otc, is_bid, is_execution_start,
                 is_execution_end, extra_info):
        """Called on every trade print."""
        with self.lock:
            # is_bid=True means the aggressor was a buyer (lifted the ask)
            self.bar.record_trade(float(price), int(size), bool(is_bid))

    def on_status_update(self, alias, status):
        print(f"[NQ Bridge] Status: {status}")

    def on_interval(self):
        """Called by Bookmap every ~100ms — we use our own timer instead."""
        pass

    # ── Bar timer ────────────────────────────────────────────────────────────

    def _start_bar_timer(self):
        t = threading.Thread(target=self._bar_loop, daemon=True)
        t.start()

    def _bar_loop(self):
        while True:
            time.sleep(BAR_SECONDS)
            self._flush_bar()

    def _flush_bar(self):
        with self.lock:
            payload = self.bar.to_payload()
            self.bar.reset()

        self._post(payload)

    def _post(self, payload: dict):
        if requests is None:
            print("[NQ Bridge] requests not installed — skipping POST")
            print("[NQ Bridge] Would have sent:", json.dumps(payload, indent=2))
            return

        try:
            resp = requests.post(
                WEBHOOK_URL,
                json=payload,
                timeout=5,
                headers={"Content-Type": "application/json"},
            )
            status = "OK" if resp.status_code == 200 else f"ERR {resp.status_code}"
            print(f"[NQ Bridge] Posted bar — delta:{payload['delta']:+d} "
                  f"bid:{payload['bid_stack_size']} ask:{payload['ask_stack_size']} "
                  f"large:{payload['large_trade_count']} → {status}")
        except Exception as e:
            print(f"[NQ Bridge] POST failed: {e}")


# ── Entry point (Bookmap calls this) ─────────────────────────────────────────
def get_module():
    return NQAnalystBridge()


# ── Standalone test (run outside Bookmap) ─────────────────────────────────────
if __name__ == "__main__":
    print("Running in standalone test mode...")
    bridge = NQAnalystBridge()

    # Simulate some trades and depth updates
    for i in range(20):
        bridge.on_depth("NQ", True,  21420 - i, 50 + i * 5)   # bids
        bridge.on_depth("NQ", False, 21425 + i, 40 + i * 3)   # asks

    bridge.on_trade("NQ", 21425, 15, False, True,  True,  True,  None)  # large buy
    bridge.on_trade("NQ", 21424, 3,  False, False, True,  True,  None)  # sell
    bridge.on_trade("NQ", 21425, 20, False, True,  True,  True,  None)  # large buy

    payload = bridge.bar.to_payload()
    print("\nGenerated payload:")
    print(json.dumps(payload, indent=2))

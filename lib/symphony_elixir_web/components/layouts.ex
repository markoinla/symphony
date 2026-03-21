defmodule SymphonyElixirWeb.Layouts do
  @moduledoc """
  Shared layouts for the observability dashboard.
  """

  use Phoenix.Component

  @spec root(map()) :: Phoenix.LiveView.Rendered.t()
  def root(assigns) do
    assigns = assign(assigns, :csrf_token, Plug.CSRFProtection.get_csrf_token())

    ~H"""
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="csrf-token" content={@csrf_token} />
        <title>Symphony Observability</title>
        <script>
          (function() {
            var saved = localStorage.getItem('symphony-theme');
            if (saved) document.documentElement.setAttribute('data-theme', saved);
          })();
        </script>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
        <script defer src="/vendor/phoenix_html/phoenix_html.js"></script>
        <script defer src="/vendor/phoenix/phoenix.js"></script>
        <script defer src="/vendor/phoenix_live_view/phoenix_live_view.js"></script>
        <script>
          function toggleTheme() {
            var html = document.documentElement;
            var current = html.getAttribute('data-theme');
            if (!current) current = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            var next = current === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', next);
            localStorage.setItem('symphony-theme', next);
          }

          window.addEventListener("DOMContentLoaded", function () {
            var csrfToken = document
              .querySelector("meta[name='csrf-token']")
              ?.getAttribute("content");

            if (!window.Phoenix || !window.LiveView) return;

            var Hooks = {};
            var scrollButtonThreshold = 72;
            var scrollButtonTarget = function (list) {
              var page = document.scrollingElement || document.documentElement;

              return list.scrollHeight > list.clientHeight + scrollButtonThreshold ? list : page;
            };
            var syncScrollBottomButtons = function () {
              document
                .querySelectorAll("[data-scroll-bottom-button]")
                .forEach(function (button) {
                  var layout = button.closest(".chat-layout");
                  var list = layout && layout.querySelector("#message-list");

                  if (!list) return;

                  var target = scrollButtonTarget(list);
                  var visible =
                    target.scrollHeight - target.scrollTop - target.clientHeight >
                      scrollButtonThreshold &&
                    list.querySelectorAll("[data-chat-entry]").length > 0;

                  button.classList.toggle("is-visible", visible);
                  button.setAttribute("aria-hidden", visible ? "false" : "true");
                  button.tabIndex = visible ? 0 : -1;
                });
            };

            document.addEventListener("click", function (event) {
              var button = event.target.closest("[data-scroll-bottom-button]");

              if (!button) return;

              var layout = button.closest(".chat-layout");
              var list = layout && layout.querySelector("#message-list");

              if (!list) return;

              var target = scrollButtonTarget(list);
              event.preventDefault();
              target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
              window.requestAnimationFrame(syncScrollBottomButtons);
            });

            window.addEventListener("scroll", syncScrollBottomButtons, { passive: true });
            document.addEventListener("scroll", syncScrollBottomButtons, { passive: true });

            Hooks.ScrollBottom = {
              mounted() {
                this.threshold = 72;
                this.wasFollowing = true;
                this.lastEntryCount = this.entryCount();
                this.lastScrollHeight = this.el.scrollHeight;
                this.following = true;
                this.frame = null;
                this.intersectionObserver = null;
                this.intersectionRoot = null;
                this.observedAnchor = null;
                this.scrollMonitor = null;
                this.resizeObserver = null;
                this.scrollAnchor = null;
                this.scrollTarget = null;
                this.scrollListenerTargets = [];
                this.scrollButton = null;
                this.onButtonClick = null;
                this.onScroll = () => {
                  this.refreshFollowingState();
                };

                this.refreshScrollTarget();
                this.refreshScrollAnchor();
                this.refreshScrollButton();
                this.refreshIntersectionObserver();
                this.refreshResizeObserver();
                this.scrollMonitor = window.setInterval(() => this.refreshFollowingState(), 150);
                this.deferScrollToBottom();
              },
              beforeUpdate() {
                this.wasFollowing = this.following;
                this.lastEntryCount = this.entryCount();
                this.lastScrollHeight = this.el.scrollHeight;
              },
              updated() {
                this.refreshScrollTarget();
                this.refreshScrollAnchor();
                this.refreshScrollButton();
                this.refreshIntersectionObserver();
                this.refreshResizeObserver();
                var grew = this.el.scrollHeight > (this.lastScrollHeight || 0) + 4;
                var hasNewEntries = this.entryCount() > (this.lastEntryCount || 0);

                if (this.wasFollowing && (grew || hasNewEntries)) {
                  this.deferScrollToBottom(hasNewEntries ? "smooth" : "auto");
                } else {
                  this.syncScrollButton();
                }

                this.lastScrollHeight = this.el.scrollHeight;
              },
              destroyed() {
                if (this.frame) cancelAnimationFrame(this.frame);
                if (this.intersectionObserver) this.intersectionObserver.disconnect();
                if (this.scrollMonitor) window.clearInterval(this.scrollMonitor);
                if (this.resizeObserver) this.resizeObserver.disconnect();
                if (this.onScroll) {
                  this.scrollListenerTargets.forEach((target) => {
                    target.removeEventListener("scroll", this.onScroll);
                  });
                }
                if (this.scrollButton && this.onButtonClick) {
                  this.scrollButton.removeEventListener("click", this.onButtonClick);
                }
              },
              distanceFromBottom() {
                var target = this.currentScrollTarget();

                return target.scrollHeight - target.scrollTop - target.clientHeight;
              },
              entryCount() {
                return this.el.querySelectorAll("[data-chat-entry]").length;
              },
              scrollToBottom(behavior) {
                var target = this.currentScrollTarget();

                target.scrollTo({
                  top: target.scrollHeight,
                  behavior: behavior || "auto"
                });

                this.following = true;
                this.lastScrollHeight = this.el.scrollHeight;
                this.syncScrollButton();
              },
              deferScrollToBottom(behavior) {
                if (this.frame) cancelAnimationFrame(this.frame);

                this.frame = requestAnimationFrame(() => {
                  this.frame = null;
                  this.scrollToBottom(behavior);
                });
              },
              refreshScrollButton() {
                var layout = this.el.closest(".chat-layout") || this.el.parentElement;
                var nextButton =
                  layout && layout.querySelector("[data-scroll-bottom-button]");

                if (this.scrollButton === nextButton) return;

                if (this.scrollButton && this.onButtonClick) {
                  this.scrollButton.removeEventListener("click", this.onButtonClick);
                }

                this.scrollButton = nextButton;

                if (!this.scrollButton) return;

                this.onButtonClick = (event) => {
                  event.preventDefault();
                  this.scrollToBottom("smooth");
                };

                this.scrollButton.addEventListener("click", this.onButtonClick);
                this.syncScrollButton();
              },
              refreshScrollAnchor() {
                this.scrollAnchor = this.el.querySelector("[data-scroll-bottom-anchor]");
              },
              refreshIntersectionObserver() {
                if (!window.IntersectionObserver) return;

                if (!this.scrollAnchor) {
                  if (this.intersectionObserver) this.intersectionObserver.disconnect();
                  this.intersectionObserver = null;
                  this.intersectionRoot = null;
                  this.observedAnchor = null;
                  return;
                }

                var root = this.currentScrollTarget() === this.el ? this.el : null;

                if (
                  this.intersectionObserver &&
                    this.intersectionRoot === root &&
                    this.observedAnchor === this.scrollAnchor
                ) {
                  return;
                }

                if (this.intersectionObserver) this.intersectionObserver.disconnect();

                this.intersectionRoot = root;
                this.observedAnchor = this.scrollAnchor;
                this.intersectionObserver = new window.IntersectionObserver(
                  (entries) => {
                    var entry = entries[entries.length - 1];

                    if (!entry) return;

                    this.following = entry.isIntersecting;
                    this.syncScrollButton();
                  },
                  {
                    root: root,
                    rootMargin: "0px 0px " + this.threshold + "px 0px",
                    threshold: 1
                  }
                );

                this.intersectionObserver.observe(this.scrollAnchor);
              },
              refreshFollowingState() {
                var following = this.distanceFromBottom() <= this.threshold;

                if (this.following === following) return;

                this.following = following;
                this.syncScrollButton();
              },
              syncScrollButton() {
                if (!this.scrollButton) return;

                var visible = !this.following && this.entryCount() > 0;

                this.scrollButton.classList.toggle("is-visible", visible);
                this.scrollButton.setAttribute("aria-hidden", visible ? "false" : "true");
                this.scrollButton.tabIndex = visible ? 0 : -1;
              },
              currentScrollTarget() {
                return this.scrollTarget || this.el;
              },
              refreshScrollTarget() {
                var page = document.scrollingElement || document.documentElement;
                var nextTarget =
                  this.el.scrollHeight > this.el.clientHeight + this.threshold ? this.el : page;
                var nextListenerTargets =
                  nextTarget === page ? [window, document, page] : [nextTarget];

                if (
                  this.scrollTarget === nextTarget &&
                    this.scrollListenerTargets.length === nextListenerTargets.length &&
                    this.scrollListenerTargets.every((target, index) => target === nextListenerTargets[index])
                ) {
                  return;
                }

                if (this.onScroll) {
                  this.scrollListenerTargets.forEach((target) => {
                    target.removeEventListener("scroll", this.onScroll);
                  });
                }

                this.scrollTarget = nextTarget;
                this.scrollListenerTargets = nextListenerTargets;

                if (this.onScroll) {
                  this.scrollListenerTargets.forEach((target) => {
                    target.addEventListener("scroll", this.onScroll, {
                      passive: true
                    });
                  });
                }

                this.following = this.distanceFromBottom() <= this.threshold;
                this.syncScrollButton();
              },
              refreshResizeObserver() {
                if (!window.ResizeObserver) return;

                if (!this.resizeObserver) {
                  this.resizeObserver = new window.ResizeObserver(() => {
                    this.refreshScrollTarget();

                    if (this.following) {
                      this.deferScrollToBottom();
                    } else {
                      this.syncScrollButton();
                    }
                  });
                }

                this.resizeObserver.disconnect();
                this.resizeObserver.observe(this.el);

                var container = this.el.querySelector(".chat-messages");
                if (container && container !== this.el) this.resizeObserver.observe(container);
              }
            };

            var liveSocket = new window.LiveView.LiveSocket("/live", window.Phoenix.Socket, {
              hooks: Hooks,
              params: {_csrf_token: csrfToken}
            });

            liveSocket.connect();
            window.liveSocket = liveSocket;
            window.setInterval(syncScrollBottomButtons, 150);
            syncScrollBottomButtons();
          });
        </script>
        <link rel="stylesheet" href="/dashboard.css" />
      </head>
      <body>
        {@inner_content}
      </body>
    </html>
    """
  end

  @spec app(map()) :: Phoenix.LiveView.Rendered.t()
  def app(assigns) do
    ~H"""
    <nav class="global-nav">
      <a href="/" class="nav-link">Dashboard</a>
      <a href="/history" class="nav-link">History</a>
      <a href="/projects" class="nav-link">Projects</a>
      <a href="/settings" class="nav-link">Settings</a>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme" aria-label="Toggle theme">
        <svg class="theme-toggle-sun" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <svg class="theme-toggle-moon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
    </nav>
    <%= if info = Phoenix.Flash.get(@flash, :info) do %>
      <div class="flash-container">
        <div class="flash flash-info" role="alert" phx-click="lv:clear-flash" phx-value-key="info"><%= info %></div>
      </div>
    <% end %>
    <%= if error = Phoenix.Flash.get(@flash, :error) do %>
      <div class="flash-container">
        <div class="flash flash-error" role="alert" phx-click="lv:clear-flash" phx-value-key="error"><%= error %></div>
      </div>
    <% end %>
    <main class="app-shell">
      {@inner_content}
    </main>
    """
  end
end

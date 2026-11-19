import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

// Mock ResizeObserver for Recharts / layout tests if needed
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof window !== "undefined") {
  window.ResizeObserver = ResizeObserverMock;
}

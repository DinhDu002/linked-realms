import { describe, expect, it } from "vitest";
import { clientAddressOf, networkOf, trustedProxies } from "./network.ts";

describe("clientAddressOf", () => {
  const trusted = trustedProxies(["10.0.0.0/8", "::1", "fd00::/8"]);

  it("is the socket's peer unless that peer is a trusted proxy", () => {
    expect(clientAddressOf(trusted, "203.0.113.5", "1.2.3.4")).toBe(
      "203.0.113.5",
    );
    expect(clientAddressOf(trustedProxies([]), "10.0.0.1", "1.2.3.4")).toBe(
      "10.0.0.1",
    );
  });

  it("behind trusted proxies, is the rightmost entry they did not add", () => {
    expect(clientAddressOf(trusted, "10.0.0.1", "1.2.3.4")).toBe("1.2.3.4");
    expect(
      clientAddressOf(trusted, "::1", "6.6.6.6, 1.2.3.4, 10.1.1.1, fd00::2"),
    ).toBe("1.2.3.4");
    expect(clientAddressOf(trusted, "10.0.0.1", " , 1.2.3.4 ,")).toBe(
      "1.2.3.4",
    );
    // nothing but proxies: the leftmost one
    expect(clientAddressOf(trusted, "10.0.0.1", "10.0.0.2")).toBe("10.0.0.2");
    expect(clientAddressOf(trusted, "10.0.0.1", undefined)).toBe("10.0.0.1");
  });

  it("treats IPv4-mapped IPv6 addresses as IPv4", () => {
    expect(clientAddressOf(trusted, "::ffff:10.0.0.1", "1.2.3.4")).toBe(
      "1.2.3.4",
    );
    expect(clientAddressOf(trusted, "::ffff:203.0.113.5", undefined)).toBe(
      "203.0.113.5",
    );
  });
});

describe("networkOf", () => {
  it("is the IPv4 address, or the /64 of an IPv6 address", () => {
    expect(networkOf("203.0.113.5")).toBe("203.0.113.5");
    expect(networkOf("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(networkOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:DB8:0001:0002::9")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
    expect(networkOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(networkOf("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });
});

describe("trustedProxies", () => {
  it("refuses anything but IPs and CIDRs", () => {
    for (const entry of [
      "10.0.0.0/33",
      "::/129",
      "proxy",
      "10.0.0.0/x",
      "1.2.3",
    ])
      expect(() => trustedProxies([entry])).toThrow(/HUB_TRUSTED_PROXIES/);
  });
});

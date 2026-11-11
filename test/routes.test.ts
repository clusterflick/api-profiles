import { describe, expect, it } from "vitest";
import { matchRoute } from "../src/routes";

const route = (path: string) =>
  matchRoute(new URL(path, "https://clusterflick.com"));

describe("matchRoute", () => {
  it("sends /u to /u/, permanently", () => {
    expect(route("/u")).toEqual({
      kind: "redirect",
      location: "/u/",
      status: 301,
    });
  });

  it("sends /u/ to /personalise/, temporarily", () => {
    expect(route("/u/")).toEqual({
      kind: "redirect",
      location: "/personalise/",
      status: 302,
    });
  });

  it.each([
    ["/u/Film-Fan", "/u/film-fan/"],
    ["/u/film-fan", "/u/film-fan/"],
    ["/u/FILM-FAN/", "/u/film-fan/"],
    ["/u/Film-Fan?ref=x", "/u/film-fan/?ref=x"],
  ])("sends %s to %s, permanently", (path, location) => {
    expect(route(path)).toEqual({ kind: "redirect", location, status: 301 });
  });

  it("reads a lowercase handle with its slash", () => {
    expect(route("/u/film_fan-99/")).toEqual({
      kind: "profile",
      handle: "film_fan-99",
    });
  });

  it.each([
    "/u/ab/",
    "/u/ab",
    `/u/${"a".repeat(31)}/`,
    "/u/film.fan/",
    "/u/film%20fan/",
    "/u/fil%C3%A9/",
    "/u/film-fan/seen/",
    "/u/film-fan//",
    "/u/film-fan/index.html",
    "/users/",
  ])("%s is not found, with no handle", (path) => {
    expect(route(path)).toEqual({ kind: "not-found" });
  });
});

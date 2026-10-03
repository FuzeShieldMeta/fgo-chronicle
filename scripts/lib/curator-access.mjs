/** @param {string[]} args */
export function parseCuratorAccessArguments(args) {
  const [action, userId, ...flags] = args;
  if (
    !action ||
    !["grant", "revoke", "check"].includes(action ?? "") ||
    !userId ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(userId)
  ) {
    throw new Error(
      "Usage: curator:access <grant|revoke|check> <user-id> [--confirm --reason=...]",
    );
  }
  if (
    flags.some((flag) => flag !== "--confirm" && !flag.startsWith("--reason="))
  )
    throw new Error("Unknown argument.");
  const reason =
    flags
      .find((flag) => flag.startsWith("--reason="))
      ?.slice(9)
      .trim() ?? "";
  if (
    action !== "check" &&
    (!flags.includes("--confirm") || reason.length < 3 || reason.length > 1000)
  ) {
    throw new Error(
      "Access changes require --confirm and --reason with 3 to 1,000 characters.",
    );
  }
  return { action, userId, reason };
}

/** @param {Record<string, any>} db @param {ReturnType<typeof parseCuratorAccessArguments>} input */
export async function manageCuratorAccess(db, input) {
  return db.$transaction(async (/** @type {Record<string, any>} */ tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true, isCurator: true },
    });
    if (!user)
      throw new Error(
        "The account does not exist. Sign in before granting access.",
      );
    if (input.action === "check") return user;
    const isCurator = input.action === "grant";
    const changed = await tx.user.update({
      where: { id: input.userId },
      data: { isCurator },
      select: { id: true, isCurator: true },
    });
    await tx.curatorChange.create({
      data: {
        actorId: "SERVER_OPERATOR",
        targetKind: "USER",
        targetId: input.userId,
        action: input.action.toUpperCase(),
        reason: input.reason,
        before: { isCurator: user.isCurator },
        after: { isCurator },
      },
    });
    return changed;
  });
}

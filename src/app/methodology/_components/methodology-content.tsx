export function MethodologyContent() {
  return (
    <>
      <p className="content-lead">
        The next two years of the Global schedule are estimates based on
        Japanese releases. The Global release may change the dates, event order
        or rewards.
      </p>

      <section>
        <h2>Schedule dates</h2>
        <p>
          Most estimated dates are the Japanese release date plus two years. If
          a source already gives a Global estimate, we use that date without
          adding another two years.
        </p>
        <ul className="content-source-list">
          <li>
            <strong>Official:</strong> Based on official Global release
            information.
          </li>
          <li>
            <strong>Curated:</strong> Entered or corrected by a curator. This
            does not mean the date is officially confirmed.
          </li>
          <li>
            <strong>Projected:</strong> Estimated from the Japanese schedule.
          </li>
        </ul>
        <p>
          Curators manually review the schedule and rewards, then adjust them
          for the Global version of the game.
        </p>
      </section>

      <section>
        <h2>Rewards</h2>
        <p>
          The forecast tracks Saint Quartz, fragments, Summon Tickets, Holy
          Grails and Crystallised Lores. Event and mission data can be
          incomplete, so some rewards may be missing or need review.
        </p>
        <p>
          Your story progress and reward selections determine what counts
          towards your balance. Select a resource tile to check the rewards,
          their sources and whether they are included.
        </p>
      </section>

      <section>
        <h2>Your balance</h2>
        <p>
          Enter your current resources and login progress in Balances. Select a
          date to plan summons. The forecast adds income and subtracts your
          planned spending from that day onwards. If you enable fragment
          conversion, seven fragments become one Saint Quartz.
        </p>
        <p>
          Your planner is saved in this browser. Clearing the site’s stored data
          can erase it. If you sign in with Google, your changes also save to
          your account so you can use the planner on other browsers and devices.
        </p>
      </section>

      <section>
        <h2>Data sources</h2>
        <ul className="content-source-list">
          <li>
            <a href="https://atlasacademy.io/" rel="noreferrer">
              Atlas Academy
            </a>{" "}
            provides game data for events, quests, missions, and Servants.
          </li>
          <li>
            <a
              href="https://fategrandorder.fandom.com/wiki/Fate/Grand_Order_Wikia"
              rel="noreferrer"
            >
              Fate/Grand Order Wiki
            </a>{" "}
            provides campaign details and rewards missing from the game data.
          </li>
        </ul>
        <p>
          Source links appear in event and reward details where available. The
          schedule updates through a daily import. Rewards marked Unreviewed
          still need checking.
        </p>
      </section>

      <aside className="content-note">
        FGO Chronicle is an unofficial fan project. It is not affiliated with
        TYPE-MOON, Aniplex, Lasengle, or the source sites listed above.
      </aside>
    </>
  );
}

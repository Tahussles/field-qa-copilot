"""Phrase banks for open-text answers, voice transcripts and contributor names.

An open-text answer combines an opener, a source-specific problem, a detail, a
consequence and a personal sentence with numbers, family members and local
landmarks, so genuine answers almost never collide. Landmarks are plausible
but synthetic.
"""

from random import Random

QUESTION = "What is the biggest challenge your household faces getting water?"

OPENERS = (
    "The biggest problem for us is",
    "Honestly, our main challenge is",
    "For my household it is mostly",
    "What troubles us most is",
    "I would say the biggest issue is",
    "Our main headache is",
    "The hardest part for this house is",
    "Mostly it is",
    "For us the challenge has always been",
    "If I am honest, it is",
    "The thing that worries me most is",
    "Our biggest struggle is",
    "In this compound the problem is",
    "What makes life hard here is",
    "The main thing is",
    "Number one problem is",
    "I think the worst part is",
    "Our family suffers most from",
    "The challenge we face every week is",
    "Above everything else, it is",
    "We struggle mainly with",
    "As a household our challenge is",
)

PROBLEMS = {
    "piped_home": (
        "the taps running dry for days at a time",
        "the low pressure in the pipe every evening",
        "water bills that keep rising even when nothing flows",
        "the pipe that keeps bursting near our gate",
        "brown water coming out of the tap after the rains",
        "the water company rationing supply to two days a week",
        "the meter reading more than we actually use",
        "illegal connections that steal pressure from our line",
        "the tap only flowing late at night",
        "waiting for weeks when the line is cut for repairs",
    ),
    "public_tap": (
        "the long queue at the public tap",
        "the communal tap being opened only in the morning",
        "paying per jerrican at the kiosk, which adds up",
        "fights in the queue at the water point",
        "the tap attendant closing early",
        "the kiosk running out of water by midday",
        "carrying heavy jerricans from the communal tap",
        "the price at the kiosk going up without notice",
        "the broken tap at the water point that nobody repairs",
        "the crowd at the tap when the supply comes back",
    ),
    "borehole": (
        "the borehole pump breaking down often",
        "the salty taste of the borehole water",
        "the long walk to the community borehole",
        "the hand pump that needs two people to operate",
        "the borehole drying up in the dry season",
        "the committee charging more for borehole water every month",
        "the queue at the borehole when the other taps fail",
        "the borehole water staining our clothes and buckets",
        "the generator for the borehole pump running out of diesel",
    ),
    "vendor": (
        "the high price that vendors charge per jerrican",
        "not knowing where the vendor's water comes from",
        "vendors doubling the price when the taps are dry",
        "waiting for the handcart vendor who comes late",
        "the cost of buying water every single day",
        "the boda boda vendors who only deliver big orders",
        "the dirty jerricans that the vendors use",
        "having to buy water on credit from the vendor",
        "vendors who mix tap water with river water",
    ),
    "river": (
        "the dirty river water during the rains",
        "the long walk down to the river",
        "the unsafe path to the river after dark",
        "the river being shared with animals",
        "the river water making the children sick",
        "the river getting low in the dry months",
        "carrying water uphill from the river",
        "rubbish and waste washing into the river",
        "the slippery banks of the river where we fetch",
    ),
}

DETAILS = (
    "especially in the dry season",
    "and it has been worse since August",
    "mostly in the evenings",
    "almost every week",
    "when the rains are delayed",
    "even on Sundays",
    "since the road works started",
    "which nobody seems to fix",
    "for as long as I have lived here",
    "and the county has not responded",
    "particularly at the end of the month",
    "and this year has been the worst",
    "more than people outside this area know",
    "on most school days",
    "whenever the power goes off",
    "which costs us both time and money",
    "even after we complained to the chief",
    "despite the new pipeline they promised",
    "during the long rains",
    "in the hot months of January and February",
)

CONSEQUENCES = (
    "the children get to school late",
    "we spend a lot on charcoal to boil the water",
    "we store water in drums and that attracts mosquitoes",
    "I wake up at four in the morning to queue",
    "we cannot keep the toilet clean",
    "we use the same water twice, first for washing then for the floor",
    "we skip bathing some days",
    "my small business suffers because I spend hours fetching",
    "the little ones keep getting stomach problems",
    "we borrow money just to buy water",
    "we cannot grow vegetables behind the house",
    "my mother cannot manage the jerricans on her own",
    "we argue with neighbours over the queue",
    "laundry waits until the weekend",
    "we have to choose between buying water and buying food",
    "the girls miss lessons to help fetch",
    "cooking takes much longer than it should",
    "we rely on rainwater from the roof when we can",
    "visitors are a burden because of the extra water",
    "we spend close to a third of our income on water",
)

CONNECTORS = (
    "So {}.",
    "Because of that, {}.",
    "It means {}.",
    "The result is that {}.",
    "That is why {}.",
    "In the end {}.",
)

FAMILY = (
    "my two small children",
    "my mother-in-law",
    "three school-going kids",
    "my elderly father",
    "my brother's twins",
    "a baby of six months",
    "my sister and her son",
    "two nephews who stay with us",
    "my grandmother",
    "four children",
)
RELATIVES = ("daughter", "son", "wife", "husband", "grandmother", "house help", "eldest boy", "niece")
WHEN = ("before school", "after work", "twice a day", "every evening", "early in the morning", "on weekends")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MONTHS = ("January", "March", "April", "May", "June", "July", "August", "September")
WORK = ("the market", "my salon", "the construction site", "my shop", "work", "the jua kali sheds")

INFORMAL_TAILS = (
    "Maji ni shida.",
    "Please help us.",
    "We need a tap closer to home.",
    "Kindly look into this.",
    "Thank you.",
    "We are tired of this.",
)


def _personal(rng: Random, landmarks: tuple[str, ...]) -> str:
    n = rng.randint(2, 11)
    k = rng.randint(2, 8)
    price = rng.choice(range(10, 65, 5))
    templates = (
        lambda: f"There are {n} of us at home, including {rng.choice(FAMILY)}.",
        lambda: f"Last {rng.choice(WEEKDAYS)} I paid {price} shillings for {k} jerricans.",
        lambda: f"It takes about {rng.randint(5, 90)} minutes to walk to the water point near {rng.choice(landmarks)}.",
        lambda: f"My {rng.choice(RELATIVES)} fetches water {rng.choice(WHEN)}.",
        lambda: f"We have lived near {rng.choice(landmarks)} for {rng.randint(1, 25)} years and it has never been this bad.",
        lambda: f"On a bad day the {n} of us manage with only {k} jerricans.",
        lambda: f"A jerrican now costs {price} shillings, up from {max(5, price - rng.choice((5, 10, 15)))} last year.",
        lambda: f"The queue near {rng.choice(landmarks)} can be {rng.randint(15, 80)} people long by seven in the morning.",
        lambda: f"Our landlord promised to fix things in {rng.choice(MONTHS)} but nothing happened.",
        lambda: f"My {rng.choice(RELATIVES)} had typhoid {rng.choice(('once', 'twice', 'three times'))} this year.",
        lambda: f"We buy {k} jerricans a day, more when my {rng.choice(RELATIVES)} visits.",
        lambda: f"I carry {k} jerricans every morning before going to {rng.choice(WORK)}.",
    )
    return rng.choice(templates)()


def open_text(rng: Random, source: str, landmarks: tuple[str, ...], *, short: bool = False) -> str:
    """Answer to QUESTION. short=True is the participants' self-report form."""
    problem = rng.choice(PROBLEMS[source])
    detail = rng.choice(DETAILS)
    personal = _personal(rng, landmarks)
    if short:
        parts = [f"{problem[0].upper()}{problem[1:]} {detail}.", personal]
        if rng.random() < 0.25:
            parts.append(rng.choice(INFORMAL_TAILS))
        return " ".join(parts)
    first = f"{rng.choice(OPENERS)} {problem}"
    if rng.random() < 0.7:
        first += f" {detail}"
    consequence = rng.choice(CONNECTORS).format(rng.choice(CONSEQUENCES))
    if rng.random() < 0.5:
        return f"{first}. {consequence} {personal}"
    return f"{personal} {first}. {consequence}"


# Single-word substitutions for near-copies. Each replaces one word with one
# word and reads correctly wherever the word appears in the banks above.
SWAPS = {
    "biggest": "largest",
    "main": "major",
    "long": "endless",
    "dirty": "muddy",
    "often": "regularly",
    "children": "kids",
    "every": "each",
    "problem": "issue",
    "challenge": "struggle",
    "mostly": "mainly",
    "high": "huge",
    "price": "cost",
    "walk": "trek",
    "evenings": "nights",
    "worst": "hardest",
    "worse": "harder",
    "buy": "purchase",
    "money": "cash",
    "small": "little",
    "heavy": "big",
    "jerricans": "containers",
    "household": "family",
    "shillings": "bob",
    "week": "month",
    "honestly": "truly",
}


def one_word_variant(rng: Random, sentence: str) -> str:
    """Change exactly one word (a known swap or a number); unchanged if none qualifies."""
    words = sentence.split(" ")
    options = [
        i for i, w in enumerate(words)
        if w.rstrip(".,").lower() in SWAPS or w.rstrip(".,").isdigit()
    ]
    if not options:
        return sentence
    i = rng.choice(options)
    core = words[i].rstrip(".,")
    tail = words[i][len(core):]
    if core.isdigit():
        new = str(max(1, int(core) + rng.choice((-2, -1, 1, 2, 5))))
    else:
        new = SWAPS[core.lower()]
        if core[0].isupper():
            new = new.capitalize()
    words[i] = new + tail
    return " ".join(words)


VOICE = {
    "piped_home": (
        "We have our own tap in the compound, but it only flows {flow}.",
        "Water comes through the pipe at home, maybe {days} days in a week.",
        "We are connected, so we fetch from our tap inside the plot.",
        "The tap at home is our source, when it works.",
        "We use the piped water at home and pay the bill every month.",
    ),
    "public_tap": (
        "We fetch from the public tap near {landmark}.",
        "We queue at the communal tap, it is {price} bob for one jerrican.",
        "Our water is from the kiosk tap, the one near {landmark}.",
        "Mostly the public tap, we carry it home in jerricans.",
    ),
    "borehole": (
        "We use the borehole near {landmark}, the water is a bit salty.",
        "We pump from the community borehole, it is about {minutes} minutes away.",
        "Our water comes from the borehole, we pay the committee {price} shillings.",
    ),
    "vendor": (
        "We buy from the vendor with the handcart, {price} shillings a jerrican.",
        "We don't have a tap, so we buy from the vendors who come around.",
        "Mostly we buy from the boda boda guys who sell water.",
        "We pay the water vendor every day, there is no tap near us.",
    ),
    "river": (
        "We get our water from the river, it is about {minutes} minutes' walk.",
        "We go down to the river, there is no tap near us.",
        "The river is where we fetch, then we boil it.",
        "We collect from the river early in the morning before the animals come.",
    ),
}
FLOW = ("at night", "two days a week", "in the early morning", "when the company opens the valve")

SOURCE_NOUNS = {
    "piped_home": "our own tap",
    "public_tap": "the public tap",
    "borehole": "the borehole",
    "vendor": "the vendor",
    "river": "the river",
}
TWO_SOURCE = (
    "Sometimes {other}, but mostly {main}.",
    "When there is no water we go to {other}, but most days it is {main}.",
    "Mostly {main}, and {other} when that fails.",
)


def voice_transcript(rng: Random, source: str, landmarks: tuple[str, ...]) -> str:
    return rng.choice(VOICE[source]).format(
        flow=rng.choice(FLOW),
        days=rng.randint(2, 4),
        landmark=rng.choice(landmarks),
        price=rng.choice(range(10, 55, 5)),
        minutes=rng.randint(5, 45),
    )


def two_source_transcript(rng: Random, main: str, other: str) -> str:
    """A genuine answer that names two sources; the recorded water_source is `main`."""
    text = rng.choice(TWO_SOURCE).format(main=SOURCE_NOUNS[main], other=SOURCE_NOUNS[other])
    return text[0].upper() + text[1:]


FIRST_NAMES = (
    "Achieng", "Akinyi", "Atieno", "Adhiambo", "Awino", "Anyango", "Auma", "Apiyo",
    "Otieno", "Ochieng", "Odhiambo", "Onyango", "Omondi", "Owino", "Ouma", "Okoth",
    "Oduor", "Juma", "Brian", "Kevin", "Dennis", "Collins", "Felix", "Victor",
    "Moses", "Evans", "Hillary", "Vincent", "Geoffrey", "Fredrick", "Wycliffe", "Erick",
    "Mercy", "Faith", "Grace", "Sharon", "Lilian", "Caroline", "Beatrice", "Millicent",
    "Pamela", "Esther", "Ruth", "Jackline", "Winnie", "Diana", "Joyce", "Maurine",
    "Lavender", "Everlyne", "Rose", "Phelix", "Benta", "Dorothy", "Christine", "Tabitha",
    "Quinter", "Risper", "Sylvia", "Duncan", "Kennedy", "Elijah",
)
SURNAMES = (
    "Otieno", "Odhiambo", "Ochieng", "Onyango", "Omondi", "Owino", "Ouma", "Okoth",
    "Oduor", "Ogola", "Ojwang", "Achieng", "Atieno", "Akinyi", "Awuor", "Wanjiru",
    "Wekesa", "Mutua", "Kiprop", "Njoroge", "Kamau", "Juma", "Barasa", "Nyongesa", "Makokha",
)


def display_name(rng: Random, taken: set[str]) -> str:
    """First name plus surname initial, unique within `taken`."""
    while True:
        name = f"{rng.choice(FIRST_NAMES)} {rng.choice(SURNAMES)[0]}."
        if name not in taken:
            taken.add(name)
            return name


You are a software engineer.
It is preferred to create software with nodejs (typescript, pnpm).

We must create a small utility to scrap cabins for sale information from a website (in norwegian).

Everything must be scrapped from this starting point https://www.finn.no/realestate/leisuresale/search.html?filters= which is a search page for cabins, with pagination (so you must follow next pages for more entries).

Create a node program following all the links to venue details for each entry, and extract the information into a standardized json structure. The field names should be translated to english (for example, "pris" should become "price", "Fasiliteter" should become "facilities", etc).

The generated json structure should include a link to the original advertisement, and the advertisement code ("FINN-kode").

To standardize json fields, take several examples of advertisements first and try to correlate standard fields.

On each advertisement, you must follow links offering more information. For example the link with the text "Utforsk" opens more information about the property.

Try also to categorize whether it's a cabin more for winter sports (alpine skiing, country skiing, etc), or for summer activities (or both), like fishing, etc. Information about altitude is a good hint that the cabin offers winter activities, while the proximity to water (lake, river, etc) is a hint that the cabin is more for summer activities.

The top of the page contains an "<ul>" html element representing a caroussel. each "<li>" contains an image that we must download. These images give a srcset with links to different version of the image, at different resolution. Download the larger resolution.

As we do not want to hit rate limiting, we should not do too many requests, too fast. The program should not do more than a request per second.

Before generating the program, you should follow a training phase, where you download information about a few properties, study the structure and optimize the program to work well with this task.


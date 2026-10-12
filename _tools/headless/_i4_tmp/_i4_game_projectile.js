if (typeof require === 'function') {
 var Classy = require('./classy');
 var EmblemState = require('./emblemstate');
 var Log = require('./log');
}
var Emblem = Classy.newClass();
Emblem.fields({
 id: null,
 playerId: null,
 type: 0,
 log: null
});
Emblem.constructor(function(emblemState) {
 this.setEmblemState(emblemState);
 this.log = Log.create('Emblem');
});
Emblem.methods({
 getId: function() {
  return this.id;
 },
 getPlayerId: function() {
  return this.playerId;
 },
 getType: function() {
  return this.type;
 },
 setEmblemState: function(emblemState) {
  this.id = emblemState.getId();
  this.playerId = emblemState.getPlayerId();
  this.type = emblemState.getType();
 },
 getEmblemState: function() {
  return EmblemState.withState(this.id, this.playerId, this.type);
 }
});
if (typeof module === 'object') {
 module.exports = Emblem;
};
if (typeof require === 'function') {
 var Classy = require('./classy');
 var ArrayUtils = require('./arrayutils');
 var MathUtils = require('./mathutils');
 var Constants = require('./constants');
 var MazeThemeManager = require('./mazethememanager');
 var Log = require('./log');
 var jKstra = require('jkstra');
}
var Maze = Classy.newClass();

/*
 * Datastructures:
 *
 * Walls:
 *      0: Right wall,
 *      1: Down wall,
 *      2: Left wall,
 *      3: Up wall
 *
 * Tiles:
 *      0: Floor present,
 *      1: Top wall present,
 *      2: Left wall present
 *
 * Wall configurations:
 *      1: Top wall,
 *      2: Left wall,
 *      4: Bottom wall,
 *      8: Right wall
 *
 * Borders:
 *      x,
 *      y,
 *      number,
 *      orientation, (-1, 0, 1, 2 indicating multiples of Math.PI / 2)
 *      flip
 * Floors:
 *      x,
 *      y,
 *      number,
 *      orientation, (0, 1, 2, 3 indicating multiples of Math.PI / 2)
 * Spaces:
 *      x,
 *      y,
 *      number,
 *      orientation, (0, 1, 2, 3 indicating multiples of Math.PI / 2)
 * Walls:
 *      x,
 *      y,
 *      number,
 *      rotate, (false, true)
 *      flipX,
 *      flipY
 * Wall decorations:
 *      x,
 *      y,
 *      number,
 *      orientation, (0, 1, 2, 3 indicating multiples of Math.PI / 2)
 */

Maze.classFields({
 log: Log.create('Maze')
});

Maze.fields({
 data: {
  theme: 0,
  tiles: [],
  borders: [],
  floors: [],
  spaces: [],
  walls: [],
  wallDecorations: []
 },
 width: 0,
 height: 0,
 graph: null, // jKstra graph representation of maze where edges carry position {x, y} of tile they point to
 vertices: [], // jKstra vertices in graph
 dijkstra: null, // jKstra Dijkstra instance for finding shortest paths in graph
 tankPositions: [], // x, y, rotation, playerId
 crateSpawnPositions: [], // x, y
 tankSpawnPositions: [], // x, y
 reachable: [], // List of reachable floors {x, y, used}
 tileToReachableIndex: [], // Map from tile (x,y) to index in reachable list
 tilePresentToTileIndex: [], // Map from index in present tiles to tile (x,y)
 tileBounds: null, // Bounds of present tiles {minX, minY, maxX, maxY}
 distances: [], // Map from tile (x,y) to array of all distances to that tile
 deadEndPenalties: [] // Map from tile (x,y) to dead end penalty score
});

Maze.constructor('withObject', function(obj) {
 this.data = obj;
 this.width = this.data.tiles.length;
 this.height = this.data.tiles[0].length;

 // Find a position to calculate reachable from.
 for (var i = 0; i < this.width; ++i) {
  for (var j = 0; j < this.height; ++j) {
   var tilePresent = this.data.tiles[i][j][0] == 1;
   if (tilePresent) {
    this._calculateReachable({
     x: i,
     y: j
    }, this.width, this.height);

    break;
   }
  }
 }

 this._calculateTileBounds();
 this._calculateDistances();
 this._calculateDeadEndPenalties();

 this._createGraph();
});

Maze.constructor('createRandom', function(width, height, playerIds, theme) {

 this.width = width;
 this.height = height;

 var wallProbability = Constants.MAZE.WALL_PROBABILITIES[Math.floor(Math.random() * Constants.MAZE.WALL_PROBABILITIES.length)];
 var tileProbability = Constants.MAZE.TILE_PROBABILITIES[Math.floor(Math.random() * Constants.MAZE.TILE_PROBABILITIES.length)];

 // Keep creating a new maze until successful.
 while (true) {
  this.tankPositions = [];

  this.data.tiles = this._createRandomMaze(this.width, this.height, wallProbability, tileProbability);

  // Place first tank.
  // Ensure that tank is placed in a tile that is present.
  this._calculateTilePresentToTileIndex(this.width, this.height);

  // Guard against the case where no tiles are present.
  if (this.tilePresentToTileIndex.length == 0)
   continue;

  var presentTile = this.tilePresentToTileIndex[Math.floor(Math.random() * this.tilePresentToTileIndex.length)];
  this.tankPositions.push({
   x: presentTile.x,
   y: presentTile.y,
   rotation: Math.random() * 2.0 * Math.PI,
   playerId: playerIds[0]
  });

  // Compute reachable tiles.
  this._calculateReachable(this.tankPositions[0], this.width, this.height);

  // Ensure that reachable tiles make up a fitting percentage of available tiles.
  var failedToReachEnoughTiles = false;
  while (this.reachable.length < Constants.MAZE_MINIMUM_REACHABLE_RATIO * this.tilePresentToTileIndex.length) {
   //console.log("Reachable too small: " + this.reachable.length + " / " + Constants.MAZE_MINIMUM_REACHABLE_RATIO * this.tilePresentToTileIndex.length);

   if (!this._expandReachable(this.tankPositions[0], this.width, this.height)) {
    if (!this._expandUnreachable(this.tankPositions[0], this.width, this.height)) {
     failedToReachEnoughTiles = true;
     break;
    }
   }
  }

  // Failed to expand reachable tiles to fitting percentage.
  if (failedToReachEnoughTiles) {
   Maze.log.error("Failed to create random maze " + width + " X " + height + " with probabilities " + wallProbability + " and " + tileProbability);
   continue;
  }

  // Mark neighbouring tiles as used.
  this._markTilesAsUsed(this.tankPositions[0], Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS);

  // Get available tiles.
  var available = this._getUnusedTiles();

  // Place remaining tanks.
  var failedToPlaceRemainingTanks = false;
  for (var i = 1; i < playerIds.length; ++i) {
   if (available.length <= 0) {
    failedToPlaceRemainingTanks = true;
    break;
   }

   var newPosition = Math.floor(Math.random() * available.length);
   this.tankPositions.push({
    x: available[newPosition].x,
    y: available[newPosition].y,
    rotation: Math.random() * 2.0 * Math.PI,
    playerId: playerIds[i]
   });

   // Mark neighbouring tiles as used.
   this._markTilesAsUsed(this.tankPositions[i], Constants.MAZE_MINIMUM_TILES_BETWEEN_TANKS);

   available = this._getUnusedTiles();
  }

  // Failed to place remaining tanks.
  if (failedToPlaceRemainingTanks) {
   continue;
  }

  // Success!
  break;
 }

 // Center on tile and convert to physical units.
 for (var i = 0; i < this.tankPositions.length; ++i) {
  this.tankPositions[i].x += 0.5;
  this.tankPositions[i].y += 0.5;
  this.tankPositions[i].x *= Constants.MAZE_TILE_SIZE.m;
  this.tankPositions[i].y *= Constants.MAZE_TILE_SIZE.m;
 }

 // Store theme.
 this.data.theme = theme;

 // Compute borders, floors, spaces, walls and decorations based on theme.
 this._calculateBorderFloorsSpacesWallsAndDecorations();

 // Compute bounds where there are tiles present.
 this._calculateTileBounds();

 // Compute distances from all tiles to all other tiles.
 this._calculateDistances();

 // Compute dead end penalties.
 this._calculateDeadEndPenalties();

 // Create graph representation.
 this._createGraph();

});

Maze.constructor('createSymmetric', function(width, height, playerIds, theme) {
 this.width = width;
 this.height = height;

 var wallProbability = Math.sqrt(Constants.MAZE.WALL_PROBABILITIES[Math.floor(Math.random() * Constants.MAZE.WALL_PROBABILITIES.length)]);
 var tileProbability = Math.sqrt(Constants.MAZE.TILE_PROBABILITIES[Math.floor(Math.random() * Constants.MAZE.TILE_PROBABILITIES.length)]);

 var blockWidth = Math.floor(this.width / 2);
 var blockHeight = Math.floor(this.height / 2);

 // Keep creating a new maze until successful.
 while (true) {
  this.tankPositions = [];

  // Start by creating a random maze representing the block of one player.
  this.data.tiles = this._createRandomMaze(blockWidth, blockHeight, wallProbability, tileProbability);

  // Place first tank.
  // Ensure that tank is placed in a tile that is present.
  this._calculateTilePresentToTileIndex(blockWidth, blockHeight);

  // Guard against the case where no tiles are present.
  if (this.tilePresentToTileIndex.length == 0)
   continue;

  var presentTile = this.tilePresentToTileIndex[0];
  this.tankPositions.push({
   x: presentTile.x,
   y: presentTile.y,
   rotation: Math.random() * 2.0 * Math.PI,
   playerId: playerIds[0]
  });

  // Compute reachable tiles.
  this._calculateReachable(this.tankPositions[0], blockWidth, blockHeight);

  // Ensure that all tiles are reachable.
  var failedToReachEnoughTiles = false;
  while (this.reachable.length < Constants.MAZE_MINIMUM_REACHABLE_RATIO * this.tilePresentToTileIndex.length) {
   //console.log("Reachable too small: " + this.reachable.length + " / " + this.tilePresentToTileIndex.length);

   if (!this._expandReachable(this.tankPositions[0], blockWidth, blockHeight)) {
    if (!this._expandUnreachable(this.tankPositions[0], blockWidth, blockHeight)) {
     failedToReachEnoughTiles = true;
     break;
    }
   }
  }

  // Failed to expand reachable tiles to all present.
  if (failedToReachEnoughTiles) {
   Maze.log.error("Failed to create symmetric maze " + width + " X " + height + " with probabilities " + wallProbability + " and " + tileProbability);
   continue;
  }

  // Ensure that at least one of the right-most tiles is present - this is enough as all tiles are reachable.
  var openToTheRight = false;
  for (var j = 0; j < blockHeight; ++j) {
   if (this.data.tiles[blockWidth - 1][j][0] == 1) {
    openToTheRight = true;
    break;
   }
  }

  // Ensure that at least one of the bottom-most tiles is present - this is enough as all tiles are reachable.
  var openToTheBottom = false;
  for (var i = 0; i < blockWidth; ++i) {
   if (this.data.tiles[i][blockHeight - 1][0] == 1) {
    openToTheBottom = true;
    break;
   }
  }

  if (!openToTheRight || !openToTheBottom) {
   continue;
  }

  // We now have a block which can be used for a symmetric, connected maze - with space in the middle for weapon spawns.
  this.data.tiles = this._createSymmetricMaze(this.data.tiles, blockWidth, blockHeight, this.width, this.height, wallProbability);

  // Place remaining tanks.
  for (var i = 1; i < playerIds.length; ++i) {
   var newPosition = {
    x: this.tankPositions[0].x,
    y: this.tankPositions[0].y,
    rotation: this.tankPositions[0].rotation,
    playerId: playerIds[i]
   };
   if (i >= 1 && i <= 2) {
    newPosition.x = this.width - 1 - newPosition.x;
    newPosition.rotation = -newPosition.rotation;
   }
   if (i % 2) {
    newPosition.y = this.height - 1 - newPosition.y;
    newPosition.rotation = Math.PI - newPosition.rotation;
   }
   this.tankPositions.push(newPosition);
  }

  // Success!
  break;
 }

 // Update reachable to the final symmetric maze.
 this._calculateReachable(this.tankPositions[0], this.width, this.height);

 // Create crate spawn positions.
 if (this.tileToReachableIndex[blockWidth][blockHeight] !== undefined) {
  this.crateSpawnPositions.push({
   x: blockWidth,
   y: blockHeight
  });
 }
 var widthEven = this.width % 2 == 0;
 var heightEven = this.height % 2 == 0;
 // If width or height is even, place more crate spawn positions.
 if (widthEven || heightEven) {
  if (widthEven) {
   if (this.tileToReachableIndex[width - 1 - blockWidth][blockHeight] !== undefined) {
    this.crateSpawnPositions.push({
     x: width - 1 - blockWidth,
     y: blockHeight
    });
   }
  }
  if (heightEven) {
   if (this.tileToReachableIndex[blockWidth][height - 1 - blockHeight] !== undefined) {
    this.crateSpawnPositions.push({
     x: blockWidth,
     y: height - 1 - blockHeight
    });
   }
  }
  if (widthEven && heightEven) {
   if (this.tileToReachableIndex[width - 1 - blockWidth][height - 1 - blockHeight] !== undefined) {
    this.crateSpawnPositions.push({
     x: width - 1 - blockWidth,
     y: height - 1 - blockHeight
    });
   }
  }
 } else {
  // FIXME Place crate spawn positions in star?
 }

 // Create tank spawn positions from first tank position.
 var tankPosition = this.tankPositions[0];
 this.tankSpawnPositions.push({
  x: tankPosition.x,
  y: tankPosition.y
 });
 this.tankSpawnPositions.push({
  x: width - 1 - tankPosition.x,
  y: tankPosition.y
 });
 this.tankSpawnPositions.push({
  x: tankPosition.x,
  y: height - 1 - tankPosition.y
 });
 this.tankSpawnPositions.push({
  x: width - 1 - tankPosition.x,
  y: height - 1 - tankPosition.y
 });

 // Center on tile and convert to physical units.
 for (var i = 0; i < this.tankPositions.length; ++i) {
  this.tankPositions[i].x += 0.5;
  this.tankPositions[i].y += 0.5;
  this.tankPositions[i].x *= Constants.MAZE_TILE_SIZE.m;
  this.tankPositions[i].y *= Constants.MAZE_TILE_SIZE.m;
 }

 // Shuffle tank position player ids.
 for (var i = 0; i < this.tankPositions.length - 1; ++i) {
  var swap = this.tankPositions[i].playerId;
  var otherIndex = Math.floor(MathUtils.randomRange(i, this.tankPositions.length));
  this.tankPositions[i].playerId = this.tankPositions[otherIndex].playerId;
  this.tankPositions[otherIndex].playerId = swap;
 }

 // Store theme.
 this.data.theme = theme;

 // Compute borders, floors, spaces, walls and decorations based on theme.
 this._calculateBorderFloorsSpacesWallsAndDecorations();

 // Compute bounds where there are tiles present.
 this._calculateTileBounds();

 // Compute distances from all tiles to all other tiles.
 this._calculateDistances();

 // Compute dead end penalties.
 this._calculateDeadEndPenalties();

 // Create graph representation.
 this._createGraph();


});

Maze.methods({
 toObj: function() {
  return this.data;
 },

 _createRandomMaze: function(width, height, wallProbability, tileProbability) {
  var walls = new Array(width + 1);
  for (var i = 0; i < walls.length; ++i) {
   walls[i] = new Array(height + 1);
   for (var j = 0; j < height + 1; ++j) {
    walls[i][j] = Math.random() > wallProbability ? 4 : Math.floor(Math.random() * 4);
   }
  }

  var tiles = new Array(width);
  for (var i = 0; i < tiles.length; ++i) {
   tiles[i] = new Array(height);
   for (var j = 0; j < height; ++j) {
    tiles[i][j] = new Array(Math.random() > tileProbability ? 0 : 1, 0, 0);
   }
  }

  for (var i = 0; i < width; ++i) {
   for (var j = 0; j < height; ++j) {
    var tilePresent = tiles[i][j][0] == 1;
    var topWall = false;
    var leftWall = false;
    if (tilePresent) {
     topWall = walls[i][j] == 0 || (i + 1 < walls.length && walls[i + 1][j] == 2) || j == 0 || (j > 0 && tiles[i][j - 1][0] == 0);
     leftWall = walls[i][j] == 1 || (j + 1 < walls[i].length && walls[i][j + 1] == 3) || i == 0 || (i > 0 && tiles[i - 1][j][0] == 0);
    } else {
     topWall = j > 0 && tiles[i][j - 1][0] == 1;
     leftWall = i > 0 && tiles[i - 1][j][0] == 1;
    }
    tiles[i][j][1] = topWall ? 1 : 0;
    tiles[i][j][2] = leftWall ? 1 : 0;
   }
  }

  return tiles;
 },

 _createSymmetricMaze: function(blockTiles, blockWidth, blockHeight, width, height, wallProbability) {
  var addVerticalConnector = width % 2;
  var addHorizontalConnector = height % 2;

  var tiles = new Array(width);
  for (var i = 0; i < tiles.length; ++i) {
   tiles[i] = new Array(height);
  }

  // Copy in upper-left block.
  for (var i = 0; i < blockWidth; ++i) {
   for (var j = 0; j < blockHeight; ++j) {
    tiles[i][j] = blockTiles[i][j];
   }
  }

  // Create lower-left block.
  for (var i = 0; i < blockWidth; ++i) {
   for (var j = 0; j < blockHeight - 1; ++j) {
    tiles[i][height - 1 - j] = new Array(blockTiles[i][j][0], blockTiles[i][j + 1][1], blockTiles[i][j][2]);
   }
  }
  for (var i = 0; i < blockWidth; ++i) {
   tiles[i][height - blockHeight] = new Array(blockTiles[i][blockHeight - 1][0], 0, blockTiles[i][blockHeight - 1][2]);
  }

  // Connect the two blocks: upper-left and lower-left.
  // First find possible connections.
  var potentialConnections = [];
  for (var i = 0; i < blockWidth; ++i) {
   if (tiles[i][blockHeight - 1][0] == 1) {
    potentialConnections.push(i);
   }
  }

  // Always close off first connection if possible.
  // Let the other ones be closed off randomly in next step.
  if (potentialConnections.length >= 2) {
   tiles[potentialConnections[0]][height - blockHeight][1] = 1;
   potentialConnections.shift();
  }

  // Close off a random amount except at least one.
  ArrayUtils.shuffle(potentialConnections);
  var amountToCloseOff = Math.floor(Math.random() * potentialConnections.length);
  for (var i = 0; i < amountToCloseOff; ++i) {
   tiles[potentialConnections[i]][height - blockHeight][1] = 1;
  }

  // Stitch blocks together with connector.
  if (addHorizontalConnector) {
   for (var i = 0; i < blockWidth; ++i) {
    var verticalNeighbourTilesPresent = tiles[i][height - blockHeight][0] == 1;
    var neighbourTopWallPresent = tiles[i][height - blockHeight][1] == 1;
    var placeTile = verticalNeighbourTilesPresent && !neighbourTopWallPresent;
    var firstConnectorTile = i == 0 && placeTile;
    var oppositeOfPreviousConnectorTile = i > 0 && (tiles[i - 1][blockHeight][0] == 0 && placeTile || tiles[i - 1][blockHeight][0] == 1 && !placeTile);
    var placeRandomWall = placeTile && Math.random() <= wallProbability;
    tiles[i][blockHeight] = new Array(placeTile ? 1 : 0, verticalNeighbourTilesPresent && neighbourTopWallPresent ? 1 : 0, firstConnectorTile || oppositeOfPreviousConnectorTile || placeRandomWall ? 1 : 0);
   }
  }

  // Create right block.
  for (var i = 0; i < blockWidth - 1; ++i) {
   for (var j = 0; j < height; ++j) {
    tiles[width - 1 - i][j] = new Array(tiles[i][j][0], tiles[i][j][1], tiles[i + 1][j][2]);
   }
  }
  for (var j = 0; j < height; ++j) {
   tiles[width - blockWidth][j] = new Array(tiles[blockWidth - 1][j][0], tiles[blockWidth - 1][j][1], 0);
  }

  // Connect the two blocks: left and right.
  // First find possible connections.
  var potentialConnections = [];
  // If horizontal connector was added, also potentially cut that off.
  for (var j = 0; j < blockHeight + (addHorizontalConnector ? 1 : 0); ++j) {
   if (tiles[blockWidth - 1][j][0] == 1) {
    potentialConnections.push(j);
   }
  }

  // Always close off first connection if possible.
  // Let the other ones be closed off randomly in next step.
  if (potentialConnections.length >= 2) {
   tiles[width - blockWidth][potentialConnections[0]][2] = 1;
   tiles[width - blockWidth][height - 1 - potentialConnections[0]][2] = 1;
   potentialConnections.shift();
  }

  // Close off a random amount except at least one.
  ArrayUtils.shuffle(potentialConnections);
  var amountToCloseOff = Math.floor(Math.random() * potentialConnections.length);
  for (var i = 0; i < amountToCloseOff; ++i) {
   tiles[width - blockWidth][potentialConnections[i]][2] = 1;
   tiles[width - blockWidth][height - 1 - potentialConnections[i]][2] = 1;
  }

  // Stitch blocks together with connector.
  if (addVerticalConnector) {
   for (var j = 0; j < height; ++j) {
    var horizontalNeighbourTilesPresent = tiles[width - blockWidth][j][0] == 1;
    var neighbourLeftWallPresent = tiles[width - blockWidth][j][2] == 1;
    var placeTile = horizontalNeighbourTilesPresent && !neighbourLeftWallPresent;
    var firstConnectorTile = j == 0 && placeTile;
    var oppositeOfPreviousConnectorTile = j > 0 && (tiles[blockWidth][j - 1][0] == 0 && placeTile || tiles[blockWidth][j - 1][0] == 1 && !placeTile);
    tiles[blockWidth][j] = new Array(placeTile ? 1 : 0, firstConnectorTile || oppositeOfPreviousConnectorTile ? 1 : 0, horizontalNeighbourTilesPresent && neighbourLeftWallPresent ? 1 : 0);
   }
   // Add random horizontal walls - need to do this as separate loop as symmetrical tiles have not been created yet in first loop.
   for (var j = 1; j <= blockHeight; ++j) {
    var horizontalNeighbourTilesPresent = tiles[width - blockWidth][j][0] == 1;
    var neighbourLeftWallPresent = tiles[width - blockWidth][j][2] == 1;
    var placeTile = horizontalNeighbourTilesPresent && !neighbourLeftWallPresent;
    var placeRandomWall = placeTile && Math.random() <= wallProbability;
    tiles[blockWidth][j][1] = tiles[blockWidth][j][1] == 1 || placeRandomWall ? 1 : 0;
    tiles[blockWidth][height - j][1] = tiles[blockWidth][height - j][1] == 1 || placeRandomWall ? 1 : 0;
   }
  }

  return tiles;
 },

 _createGraph: function() {
  this.graph = new jKstra.Graph();

  this.vertices = new Array(this.width);
  for (var i = 0; i < this.width; ++i) {
   this.vertices[i] = new Array(this.height);
  }

  // Create vertex for each tile present.
  for (var i = 0; i < this.width; ++i) {
   for (var j = 0; j < this.height; ++j) {
    if (this.data.tiles[i][j][0] == 1) {
     this.vertices[i][j] = this.graph.addVertex({
      x: i,
      y: j
     });
    }
   }
  }

  // Create edge pairs between neighbouring tiles.
  var self = this;
  this.graph.forEachVertex(function(v) {
   var current = v.data;

   // Check if we can move left.
   if (current.x > 0 && self.data.tiles[current.x][current.y][2] == 0) {
    self.graph.addEdge(v, self.vertices[current.x - 1][current.y], {
     x: current.x - 1,
     y: current.y,
     length: 1
    });
   }

   // Check if we can move right.
   if (current.x < self.width - 1 && self.data.tiles[current.x + 1][current.y][2] == 0) {
    self.graph.addEdge(v, self.vertices[current.x + 1][current.y], {
     x: current.x + 1,
     y: current.y,
     length: 1
    });
   }

   // Check if we can move down.
   if (current.y < self.height - 1 && self.data.tiles[current.x][current.y + 1][1] == 0) {
    self.graph.addEdge(v, self.vertices[current.x][current.y + 1], {
     x: current.x,
     y: current.y + 1,
     length: 1
    });
   }

   // Check if we can move up.
   if (current.y > 0 && self.data.tiles[current.x][current.y][1] == 0) {
    self.graph.addEdge(v, self.vertices[current.x][current.y - 1], {
     x: current.x,
     y: current.y - 1,
     length: 1
    });
   }

   // Check if we can move left-down.
   if (current.x > 0 && current.y < self.height - 1 && self.data.tiles[current.x][current.y][2] == 0 && self.data.tiles[current.x][current.y + 1][2] == 0 && self.data.tiles[current.x][current.y + 1][1] == 0 && self.data.tiles[current.x - 1][current.y + 1][1] == 0) {
    self.graph.addEdge(v, self.vertices[current.x - 1][current.y + 1], {
     x: current.x - 1,
     y: current.y + 1,
     length: Math.SQRT2
    });
   }

   // Check if we can move right-down.
   if (current.x < self.width - 1 && current.y < self.height - 1 && self.data.tiles[current.x + 1][current.y][2] == 0 && self.data.tiles[current.x + 1][current.y + 1][2] == 0 && self.data.tiles[current.x][current.y + 1][1] == 0 && self.data.tiles[current.x + 1][current.y + 1][1] == 0) {
    self.graph.addEdge(v, self.vertices[current.x + 1][current.y + 1], {
     x: current.x + 1,
     y: current.y + 1,
     length: Math.SQRT2
    });
   }

   // Check if we can move left-up.
   if (current.x > 0 && current.y > 0 && self.data.tiles[current.x][current.y][2] == 0 && self.data.tiles[current.x][current.y - 1][2] == 0 && self.data.tiles[current.x][current.y][1] == 0 && self.data.tiles[current.x - 1][current.y][1] == 0) {
    self.graph.addEdge(v, self.vertices[current.x - 1][current.y - 1], {
     x: current.x - 1,
     y: current.y - 1,
     length: Math.SQRT2
    });
   }

   // Check if we can move right-up.
   if (current.x < self.width - 1 && current.y > 0 && self.data.tiles[current.x + 1][current.y][2] == 0 && self.data.tiles[current.x + 1][current.y - 1][2] == 0 && self.data.tiles[current.x][current.y][1] == 0 && self.data.tiles[current.x + 1][current.y][1] == 0) {
    self.graph.addEdge(v, self.vertices[current.x + 1][current.y - 1], {
     x: current.x + 1,
     y: current.y - 1,
     length: Math.SQRT2
    });
   }
  });

  this.dijkstra = new jKstra.algos.Dijkstra(this.graph);
 },

 // Can work on just a subset of the maze defined by width and height parameters.
 _calculateTilePresentToTileIndex: function(width, height) {
  this.tilePresentToTileIndex = new Array();
  for (var i = 0; i < width; ++i) {
   for (var j = 0; j < height; ++j) {
    var tilePresent = this.data.tiles[i][j][0] == 1;
    if (tilePresent) {
     this.tilePresentToTileIndex.push({
      x: i,
      y: j
     });
    }
   }
  }
 },

 // Can work on just a subset of the maze defined by width and height parameters.
 _calculateReachable: function(tankPosition, width, height) {
  this.tileToReachableIndex = new Array(width);
  for (var i = 0; i < width; ++i) {
   this.tileToReachableIndex[i] = new Array(height);
  }

  this.reachable = [];

  var self = this;
  this._traverseCloseTiles(tankPosition, Number.MAX_VALUE, width, height, function(current) {
   self.tileToReachableIndex[current.x][current.y] = self.reachable.length;
   self.reachable.push({
    x: current.x,
    y: current.y,
    used: false
   });
  });
 },

 // Can work on just a subset of the maze defined by width and height parameters.
 _expandReachable: function(tankPosition, width, height) {
  var foundExpansion = false;

  //console.log("Try to expand reachable");

  // Shuffle indexes to randomize reachable walkthrough.
  var reachableIndex = new Array();
  for (var i = 0; i < this.reachable.length; ++i) {
   reachableIndex.push(i);
  }
  ArrayUtils.shuffle(reachableIndex);

  // Walk through the reachable tiles and attempt to find a neighbouring unreachable tile, which we can punch a hole to.
  for (var i = 0; i < this.reachable.length; ++i) {
   var current = this.reachable[reachableIndex[i]];

   // Check left.
   if (current.x > 0 && this.data.tiles[current.x - 1][current.y][0] == 1 && this.tileToReachableIndex[current.x - 1][current.y] === undefined) {
    this.data.tiles[current.x][current.y][2] = 0;
    //console.log("Found expansion to the left of: " + current.x + ", " + current.y);
    foundExpansion = true;
    break;
   }

   // Check right.
   if (current.x < width - 1 && this.data.tiles[current.x + 1][current.y][0] == 1 && this.tileToReachableIndex[current.x + 1][current.y] === undefined) {
    this.data.tiles[current.x + 1][current.y][2] = 0;
    //console.log("Found expansion to the right of: " + current.x + ", " + current.y);
    foundExpansion = true;
    break;
   }

   // Check down.
   if (current.y < height - 1 && this.data.tiles[current.x][current.y + 1][0] == 1 && this.tileToReachableIndex[current.x][current.y + 1] === undefined) {
    this.data.tiles[current.x][current.y + 1][1] = 0;
    //console.log("Found expansion under: " + current.x + ", " + current.y);
    foundExpansion = true;
    break;
   }

   // Check up.
   if (current.y > 0 && this.data.tiles[current.x][current.y - 1][0] == 1 && this.tileToReachableIndex[current.x][current.y - 1] === undefined) {
    this.data.tiles[current.x][current.y][1] = 0;
    //console.log("Found expansion over: " + current.x + ", " + current.y);
    foundExpansion = true;
    break;
   }

  }

  if (foundExpansion) {
   this._calculateReachable(tankPosition, width, height);
  }

  return foundExpansion;
 },

 // Can work on just a subset of the maze defined by width and height parameters.
 _expandUnreachable: function(tankPosition, width, height) {
  var foundExpansion = false;

  var unreachable = new Array();

  // Look for unreachable, present tiles.
  for (var i = 0; i < width; ++i) {
   for (var j = 0; j < height; ++j) {
    if (this.data.tiles[i][j][0] == 1 && this.tileToReachableIndex[i][j] === undefined) {
     unreachable.push({
      x: i,
      y: j
     });
    }
   }
  }

  // Shuffle the found tiles.
  ArrayUtils.shuffle(unreachable);

  // Try to expand an unreachable, present tile.
  for (var i = 0; i < unreachable.length; ++i) {
   var current = unreachable[i];

   // Check left.
   if (current.x > 0 && this.data.tiles[current.x - 1][current.y][0] == 0) {
    this._addTile(current.x - 1, current.y, width, height);
    foundExpansion = true;
   }

   // Check right.
   if (current.x < width - 1 && this.data.tiles[current.x + 1][current.y][0] == 0) {
    this._addTile(current.x + 1, current.y, width, height);
    foundExpansion = true;
   }

   // Check down.
   if (current.y < height - 1 && this.data.tiles[current.x][current.y + 1][0] == 0) {
    this._addTile(current.x, current.y + 1, width, height);
    foundExpansion = true;
   }

   // Check up.
   if (current.y > 0 && this.data.tiles[current.x][current.y - 1][0] == 0) {
    this._addTile(current.x, current.y - 1, width, height);
    foundExpansion = true;
   }

   if (foundExpansion) {
    break;
   }
  }

  if (foundExpansion) {
   this._calculateReachable(tankPosition, width, height);
   this._calculateTilePresentToTileIndex(width, height);
  }

  return foundExpansion;
 },

 // Can work on just a subset of the maze defined by width and height parameters.
 _addTile: function(x, y, width, height) {
  // Update tile.
  this.data.tiles[x][y][0] = 1;

  // Update left wall.
  if (x <= 0 || this.data.tiles[x - 1][y][0] == 0) {
   this.data.tiles[x][y][2] = 1;
  }

  // Update right wall.
  if (x < width - 1 && this.data.tiles[x + 1][y][0] == 0) {
   this.data.tiles[x + 1][y][2] = 1;
  }

  // Update top wall.
  if (y <= 0 || this.data.tiles[x][y - 1][0] == 0) {
   this.data.tiles[x][y][1] = 1;
  }

  // Update bottom wall.
  if (y < height - 1 && this.data.tiles[x][y + 1][0] == 0) {
   this.data.tiles[x][y + 1][1] = 1;
  }
 },

 // Can work on just a subset of the maze defined by width and height parameters.
 _traverseCloseTiles: function(position, maximumDistance, width, height, traverseFn) {
  var alreadyAddedToWorklist = new Array(width);
  for (var i = 0; i < width; ++i) {
   alreadyAddedToWorklist[i] = new Array(height);
  }

  var worklist = [];
  worklist.push({
   x: position.x,
   y: position.y,
   distance: 0
  });

  alreadyAddedToWorklist[position.x][position.y] = true;

  while (worklist.length > 0) {
   var current = worklist.shift();

   // If we have moved too far away, stop traversing this path.
   if (current.distance > maximumDistance)
    continue;

   traverseFn(current);

   // Check if we can move left.
   if (current.x > 0 && this.data.tiles[current.x][current.y][2] == 0) {
    if (alreadyAddedToWorklist[current.x - 1][current.y] === undefined) {
     alreadyAddedToWorklist[current.x - 1][current.y] = true;
     worklist.push({
      x: current.x - 1,
      y: current.y,
      distance: current.distance + 1
     });
    }
   }

   // Check if we can move right.
   if (current.x < width - 1 && this.data.tiles[current.x + 1][current.y][2] == 0) {
    if (alreadyAddedToWorklist[current.x + 1][current.y] === undefined) {
     alreadyAddedToWorklist[current.x + 1][current.y] = true;
     worklist.push({
      x: current.x + 1,
      y: current.y,
      distance: current.distance + 1
     });
    }
   }

   // Check if we can move down.
   if (current.y < height - 1 && this.data.tiles[current.x][current.y + 1][1] == 0) {
    if (alreadyAddedToWorklist[current.x][current.y + 1] === undefined) {
     alreadyAddedToWorklist[current.x][current.y + 1] = true;
     worklist.push({
      x: current.x,
      y: current.y + 1,
      distance: current.distance + 1
     });
    }
   }

   // Check if we can move up.
   if (current.y > 0 && this.data.tiles[current.x][current.y][1] == 0) {
    if (alreadyAddedToWorklist[current.x][current.y - 1] === undefined) {
     alreadyAddedToWorklist[current.x][current.y - 1] = true;
     worklist.push({
      x: current.x,
      y: current.y - 1,
      distance: current.distance + 1
     });
    }
   }
  }
 },

 _markTilesAsUsed: function(position, minimumDistance) {
  var self = this;
  this._traverseCloseTiles(position, minimumDistance, this.width, this.height, function(current) {
   // Mark tile as used.
   self.reachable[self.tileToReachableIndex[current.x][current.y]].used = true;
  });

 },

 _clearUsedTiles: function() {
  for (var i = 0; i < this.reachable.length; ++i) {
   this.reachable[i].used = false;
  }
 },

 _getUnusedTiles: function() {
  var unused = new Array();

  for (var i = 0; i < this.reachable.length; ++i) {
   var current = this.reachable[i];
   if (!current.used) {
    unused.push({
     x: current.x,
     y: current.y
    });
   }
  }

  return unused;
 },

 traverseCloseTiles: function(position, maximumDistance, traverseFn) {
  if (!this._isPositionInsideMaze(position)) {
   Maze.log.error("A position was outside the maze.");
   return;
  }

  this._traverseCloseTiles(position, maximumDistance, this.width, this.height, traverseFn);
 },

 getTheme: function() {
  return this.data.theme;
 },

 getWidth: function() {
  return this.width;
 },

 getHeight: function() {
  return this.height;
 },

 getTiles: function() {
  return this.data.tiles;
 },

 getBorders: function() {
  return this.data.borders;
 },

 getFloors: function() {
  return this.data.floors;
 },

 getSpaces: function() {
  return this.data.spaces;
 },

 getWalls: function() {
  return this.data.walls;
 },

 getWallDecorations: function() {
  return this.data.wallDecorations;
 },

 getTileBounds: function() {
  return this.tileBounds;
 },

 getDistances: function() {
  return this.distances;
 },

 getDistancesFromPosition: function(position) {
  if (!this._isPositionInsideMaze(position)) {
   return false;
  }
  return this.distances[position.x][position.y];
 },

 getDistanceBetweenPositions: function(startPosition, endPosition) {
  if (!this._isPositionInsideMaze(startPosition) || !this._isPositionInsideMaze(endPosition)) {
   return false;
  }
  return this.distances[startPosition.x][startPosition.y][endPosition.x][endPosition.y];
 },

 getDistanceToPosition: function(distances, position) {
  if (!this._isPositionInsideMaze(position)) {
   return false;
  }
  return distances[position.x][position.y];
 },

 getDeadEndPenalties: function() {
  return this.deadEndPenalties;
 },

 getDeadEndPenalty(position) {
  if (!this._isPositionInsideMaze(position)) {
   return 0;
  }

  return this.deadEndPenalties[position.x][position.y];
 },

 getReachable: function() {
  return this.reachable;
 },

 getReachableIndexFromPosition: function(position) {
  if (!this._isPositionInsideMaze(position)) {
   return false;
  }
  return this.tileToReachableIndex[position.x][position.y];
 },

 getTankPositions: function() {
  return this.tankPositions;
 },

 getRandomUnusedPosition: function(roundState, minimumDistance) {
  // Update positions already in use.
  this._updateUsedPositions(roundState, minimumDistance, true);

  var unused = this._getUnusedTiles();

  return this._getRandomPosition(unused);
 },

 getCrateSpawnPosition: function(roundState) {
  // Update positions already in use.
  this._updateUsedPositions(roundState, 0, true);

  var unused = this._getUnusedTiles();

  // Filter out spawn positions that are already in use.
  var comparePositionFn = function(a, b) {
   return a.x == b.x && a.y == b.y
  };
  var availablePositions = new Array();
  for (var i = 0; i < this.crateSpawnPositions.length; i++) {
   var crateSpawnPosition = this.crateSpawnPositions[i];
   var unusedIndex = ArrayUtils.indexOf(unused, crateSpawnPosition, comparePositionFn);
   if (unusedIndex != -1) {
    availablePositions.push(unused[unusedIndex]);
   }
  }

  return this._getRandomPosition(availablePositions);
 },

 // FIXME Add team information to spawn positions.
 getTankSpawnPosition: function(roundState) {
  // Update positions already in use.
  this._updateUsedPositions(roundState, 0, false);

  var unused = this._getUnusedTiles();

  // Filter out spawn positions that are already in use.
  var comparePositionFn = function(a, b) {
   return a.x == b.x && a.y == b.y
  };
  var availablePositions = new Array();
  for (var i = 0; i < this.tankSpawnPositions.length; i++) {
   var tankSpawnPosition = this.tankSpawnPositions[i];
   var unusedIndex = ArrayUtils.indexOf(unused, tankSpawnPosition, comparePositionFn);
   if (unusedIndex != -1) {
    availablePositions.push(unused[unusedIndex]);
   }
  }

  // Find the position with highest distance to other tanks.
  var tankStates = roundState.getTankStates();

  var maxDistance = 0;
  var bestPositions = [];
  for (var i = 0; i < availablePositions.length; ++i) {
   var availablePosition = availablePositions[i];
   var distances = this.getDistancesFromPosition(availablePosition);
   var distance = Number.MAX_VALUE;
   for (var j = 0; j < tankStates.length; j++) {
    var tankState = tankStates[j];

    var position = {
     x: Math.floor(tankState.getX() / Constants.MAZE_TILE_SIZE.m),
     y: Math.floor(tankState.getY() / Constants.MAZE_TILE_SIZE.m)
    };

    // FIXME This should not be strictly necessary as server verifies tank state positions.
    if (!this._isPositionInsideMaze(position)) {
     Maze.log.error("A tank position was outside the maze. This should have been corrected by the server!");
     continue;
    }

    distance = Math.min(distance, distances[position.x][position.y]);
   }

   if (distance > maxDistance) {
    maxDistance = distance;
    bestPositions = new Array(availablePosition);
   } else if (distance == maxDistance) {
    bestPositions.push(availablePosition);
   }
  }

  return this._getRandomPosition(bestPositions);
 },

 // Selects a random tile position from array and makes it a physical position with a rotation.
 _getRandomPosition: function(positions) {
  if (positions.length == 0) {
   return undefined;
  }

  var position = MathUtils.randomArrayEntry(positions);

  return this._makePositionPhysical(position);
 },

 _makePositionPhysical: function(position) {
  position.x += 0.5;
  position.y += 0.5;
  position.x *= Constants.MAZE_TILE_SIZE.m;
  position.y *= Constants.MAZE_TILE_SIZE.m;

  position.rotation = Math.random() * 2.0 * Math.PI;

  return position;
 },

 isTankStateInsideMaze: function(tankState) {
  var position = {
   x: Math.floor(tankState.getX() / Constants.MAZE_TILE_SIZE.m),
   y: Math.floor(tankState.getY() / Constants.MAZE_TILE_SIZE.m)
  };
  return this._isPositionInsideMaze(position);
 },

 isPositionInsideMaze: function(position) {
  if (position.x < 0 ||
   position.x >= this.width ||
   position.y < 0 ||
   position.y >= this.height) {
   return false;
  }

  var distances = this.distances[position.x][position.y];
  if (distances === null) {
   return false;
  }

  return true;
 },

 _isPositionInsideMaze: function(position) {
  if (position.x < 0 ||
   position.x >= this.width ||
   position.y < 0 ||
   position.y >= this.height) {
   Maze.log.error('Position outside tiles: ' + position.x + ", " + position.y);
   return false;
  }

  var distances = this.distances[position.x][position.y];
  if (distances === null) {
   Maze.log.error('Position pointing to invalid tile: ' + position.x + ", " + position.y);
   return false;
  }

  return true;
 },

 _updateUsedPositions: function(roundState, minimumDistance, includeTankSpawnPositions) {
  // Clear previous used marking.
  this._clearUsedTiles();

  // Iterate over tanks, collectibles, traps and zones and mark neighbouring tiles as used.
  var tankStates = roundState.getTankStates();
  for (var i = 0; i < tankStates.length; i++) {
   var tankState = tankStates[i];

   var position = {
    x: Math.floor(tankState.getX() / Constants.MAZE_TILE_SIZE.m),
    y: Math.floor(tankState.getY() / Constants.MAZE_TILE_SIZE.m)
   };

   // FIXME This should not be strictly necessary as server verifies tank state positions.
   if (!this._isPositionInsideMaze(position)) {
    Maze.log.error("A tank position was outside the maze. This should have been corrected by the server!");
    continue;
   }

   this._markTilesAsUsed(position, minimumDistance);
  }

  var trapStates = roundState.getTrapStates();
  for (var i = 0; i < trapStates.length; i++) {
   var trapState = trapStates[i];

   var position = {
    x: Math.floor(trapState.getX() / Constants.MAZE_TILE_SIZE.m),
    y: Math.floor(trapState.getY() / Constants.MAZE_TILE_SIZE.m)
   };

   if (!this._isPositionInsideMaze(position)) {
    Maze.log.error("A trap position was outside the maze. This indicates that someone wall-hacked the game!");
    continue;
   }

   this._markTilesAsUsed(position, 0);
  }

  var collectibleStates = roundState.getCollectibleStates();
  for (var i = 0; i < collectibleStates.length; i++) {
   var collectibleState = collectibleStates[i];

   var position = {
    x: Math.floor(collectibleState.getX() / Constants.MAZE_TILE_SIZE.m),
    y: Math.floor(collectibleState.getY() / Constants.MAZE_TILE_SIZE.m)
   };

   this._markTilesAsUsed(position, 0);
  }

  var zoneStates = roundState.getZoneStates();
  for (var i = 0; i < zoneStates.length; i++) {
   var zoneState = zoneStates[i];

   switch (zoneState.getType()) {
    case Constants.ZONE_TYPES.SPAWN: {
     var tiles = zoneState.getTiles();
     for (var j = 0; j < tiles.length; j++) {
      this._markTilesAsUsed(tiles[j], 0);
     }
     break;
    }
    case Constants.ZONE_TYPES.STORM: {
     var tiles = zoneState.getTiles();
     for (var j = 0; j < tiles.length; j++) {
      this._markTilesAsUsed(tiles[j], 0);
     }
     break;
    }
   }
  }

  if (includeTankSpawnPositions) {
   for (var i = 0; i < this.tankSpawnPositions.length; i++) {
    var tankSpawnPosition = this.tankSpawnPositions[i];
    this._markTilesAsUsed(tankSpawnPosition, 0);
   }
  }
 },

 getStormExpansionSequence: function() {
  var result = [];
  var tileBounds = this.getTileBounds();
  var remainingWidth = (tileBounds.maxX - tileBounds.minX) + 1;
  var remainingHeight = (tileBounds.maxY - tileBounds.minY) + 1;
  while (remainingWidth > 0 && remainingHeight > 0) {
   var horizontalWeight = remainingWidth / (remainingWidth + remainingHeight);
   if (Math.random() < horizontalWeight) {
    // Expand horizontally.
    result.push(Math.random() < 0.5 ? 0 : 2);
    remainingWidth -= 1;
   } else {
    // Expand vertically.
    result.push(Math.random() < 0.5 ? 1 : 3);
    remainingHeight -= 1;
   }
  }

  return result;
 },

 _calculateBorderFloorsSpacesWallsAndDecorations: function() {
  this.data.borders = [];
  this.data.floors = [];
  this.data.spaces = [];
  this.data.walls = [];
  this.data.wallDecorations = [];

  var tileToWallConfiguration = new Array(this.width);
  for (var i = 0; i < this.width; ++i) {
   tileToWallConfiguration[i] = new Array(this.height);
  }

  // Calculate wall configurations.
  for (var i = 0; i < this.width; ++i) {
   for (var j = 0; j < this.height; ++j) {
    tileToWallConfiguration[i][j] = (this.data.tiles[i][j][1] << 0) +
     (this.data.tiles[i][j][2] << 1) +
     ((j < this.height - 1 ? this.data.tiles[i][j + 1][1] : this.data.tiles[i][j][0]) << 2) +
     ((i < this.width - 1 ? this.data.tiles[i + 1][j][2] : this.data.tiles[i][j][0]) << 3);
   }
  }

  // Find all spaces and internal borders.
  for (var i = 0; i < this.width; ++i) {
   for (var j = 0; j < this.height; ++j) {

    var tilePresent = this.data.tiles[i][j][0] == 1;
    if (tilePresent) {
     var floor = MazeThemeManager.getRandomFloor(this.data.theme, tileToWallConfiguration[i][j]);
     if (floor) {
      this.data.floors.push({
       x: i,
       y: j,
       number: floor.number,
       orientation: floor.orientation
      });
     }
     var wallDecoration = MazeThemeManager.getRandomWallDecoration(this.data.theme, tileToWallConfiguration[i][j]);
     if (wallDecoration) {
      this.data.wallDecorations.push({
       x: i,
       y: j,
       number: wallDecoration.number,
       orientation: wallDecoration.orientation
      });
     }
    } else {
     if (tileToWallConfiguration[i][j] === 15 || this._isClosedOffSpace({
       x: i,
       y: j
      })) {
      var space = MazeThemeManager.getRandomSpace(this.data.theme, tileToWallConfiguration[i][j]);
      if (space) {
       this.data.spaces.push({
        x: i,
        y: j,
        number: space.number,
        orientation: space.orientation
       });
      }
     } else {
      var borders = MazeThemeManager.getRandomBorders(this.data.theme, tileToWallConfiguration[i][j]);
      for (var k = 0; k < borders.length; ++k) {
       var border = borders[k];
       this.data.borders.push({
        x: i,
        y: j,
        number: border.number,
        orientation: border.orientation,
        flip: border.flip
       });
      }
     }
    }
   }
  }
  // Find all outer borders.
  for (var i = 0; i < this.width; ++i) {
   if (this.data.tiles[i][0][1] == 1) {
    var borders = MazeThemeManager.getRandomBorders(this.data.theme, 1 << 2);
    for (var k = 0; k < borders.length; ++k) {
     var border = borders[k];
     this.data.borders.push({
      x: i,
      y: -1,
      number: border.number,
      orientation: border.orientation,
      flip: border.flip
     });
    }
   }
   if (this.data.tiles[i][this.height - 1][0] == 1) {
    var borders = MazeThemeManager.getRandomBorders(this.data.theme, 1 << 0);
    for (var k = 0; k < borders.length; ++k) {
     var border = borders[k];
     this.data.borders.push({
      x: i,
      y: this.height,
      number: border.number,
      orientation: border.orientation,
      flip: border.flip
     });
    }
   }
  }
  for (var j = 0; j < this.height; ++j) {
   if (this.data.tiles[0][j][2] == 1) {
    var borders = MazeThemeManager.getRandomBorders(this.data.theme, 1 << 3);
    for (var k = 0; k < borders.length; ++k) {
     var border = borders[k];
     this.data.borders.push({
      x: -1,
      y: j,
      number: border.number,
      orientation: border.orientation,
      flip: border.flip
     });
    }
   }
   if (this.data.tiles[this.width - 1][j][0] == 1) {
    var borders = MazeThemeManager.getRandomBorders(this.data.theme, 1 << 1);
    for (var k = 0; k < borders.length; ++k) {
     var border = borders[k];
     this.data.borders.push({
      x: this.width,
      y: j,
      number: border.number,
      orientation: border.orientation,
      flip: border.flip
     });
    }
   }
  }
  // Find all internal walls.
  for (var i = 0; i < this.width; ++i) {
   for (var j = 0; j < this.height; ++j) {
    var walls = MazeThemeManager.getRandomWalls(this.data.theme, tileToWallConfiguration[i][j]);
    for (var k = 0; k < walls.length; ++k) {
     var wall = walls[k];
     this.data.walls.push({
      x: i,
      y: j,
      number: wall.number,
      rotate: wall.rotate,
      flipX: wall.flipX,
      flipY: wall.flipY
     });
    }
   }
  }
  // Find all outer walls.
  for (var i = 0; i < this.width; ++i) {
   if (this.data.tiles[i][this.height - 1][0] == 1) {
    var walls = MazeThemeManager.getRandomWalls(this.data.theme, 1 << 0);
    for (var k = 0; k < walls.length; ++k) {
     var wall = walls[k];
     this.data.walls.push({
      x: i,
      y: this.height,
      number: wall.number,
      rotate: wall.rotate,
      flipX: wall.flipX,
      flipY: wall.flipY
     });
    }
   }
  }
  for (var j = 0; j < this.height; ++j) {
   if (this.data.tiles[this.width - 1][j][0] == 1) {
    var walls = MazeThemeManager.getRandomWalls(this.data.theme, 1 << 1);
    for (var k = 0; k < walls.length; ++k) {
     var wall = walls[k];
     this.data.walls.push({
      x: this.width,
      y: j,
      number: wall.number,
      rotate: wall.rotate,
      flipX: wall.flipX,
      flipY: wall.flipY
     });
    }
   }
  }
 },

 _isClosedOffSpace: function(startPosition) {
  var alreadyAddedToWorklist = new Array(this.width);
  for (var i = 0; i < this.width; ++i) {
   alreadyAddedToWorklist[i] = new Array(this.height);
  }


  var worklist = [];
  worklist.push({
   x: startPosition.x,
   y: startPosition.y
  });

  alreadyAddedToWorklist[startPosition.x][startPosition.y] = true;

  while (worklist.length > 0) {
   var current = worklist.pop();

   // If at any point, we reach the edge of the maze. We know the space is not closed off.
   if (current.x == 0 || current.x == this.width - 1 || current.y == 0 || current.y == this.height - 1) {
    return false;
   }

   // Check if we can move left.
   if (this.data.tiles[current.x][current.y][2] == 0) {
    if (alreadyAddedToWorklist[current.x - 1][current.y] === undefined) {
     alreadyAddedToWorklist[current.x - 1][current.y] = true;
     worklist.push({
      x: current.x - 1,
      y: current.y
     });
    }
   }

   // Check if we can move right.
   if (this.data.tiles[current.x + 1][current.y][2] == 0) {
    if (alreadyAddedToWorklist[current.x + 1][current.y] === undefined) {
     alreadyAddedToWorklist[current.x + 1][current.y] = true;
     worklist.push({
      x: current.x + 1,
      y: current.y
     });
    }
   }

   // Check if we can move down.
   if (this.data.tiles[current.x][current.y + 1][1] == 0) {
    if (alreadyAddedToWorklist[current.x][current.y + 1] === undefined) {
     alreadyAddedToWorklist[current.x][current.y + 1] = true;
     worklist.push({
      x: current.x,
      y: current.y + 1
     });
    }
   }

   // Check if we can move up.
   if (this.data.tiles[current.x][current.y][1] == 0) {
    if (alreadyAddedToWorklist[current.x][current.y - 1] === undefined) {
     alreadyAddedToWorklist[current.x][current.y - 1] = true;
     worklist.push({
      x: current.x,
      y: current.y - 1
     });
    }
   }
  }

  // We never reached the edge of the maze, so the starting position must be part of a closed off space.
  return true;
 },

 _calculateTileBounds: function() {
  this.tileBounds = {
   minX: this.width,
   minY: this.height,
   maxX: 0,
   maxY: 0
  };
  for (var i = 0; i < this.width; ++i) {
   for (var j = 0; j < this.height; ++j) {
    if (this.data.tiles[i][j][0] == 1) {
     this.tileBounds.minX = Math.min(i, this.tileBounds.minX);
     this.tileBounds.minY = Math.min(j, this.tileBounds.minY);
     this.tileBounds.maxX = Math.max(i, this.tileBounds.maxX);
     this.tileBounds.maxY = Math.max(j, this.tileBounds.maxY);
    }
   }
  }
 },

 _calculateDistances: function() {
  // Allocate distances array.
  this.distances = new Array(this.width);
  for (var i = 0; i < this.width; ++i) {
   this.distances[i] = new Array(this.height);
   for (var j = 0; j < this.height; ++j) {
    this.distances[i][j] = null;
   }
  }

  for (var i = 0; i < this.reachable.length; ++i) {
   this.distances[this.reachable[i].x][this.reachable[i].y] = this._calculateDistancesFromPosition(this.reachable[i]);
  }
 },

 _calculateDistancesFromPosition: function(position) {
  var result = new Array(this.width);
  for (var i = 0; i < this.width; ++i) {
   result[i] = new Array(this.height);
   for (var j = 0; j < this.height; ++j) {
    result[i][j] = Number.MAX_VALUE;
   }
  }

  this._traverseCloseTiles(position, Number.MAX_VALUE, this.width, this.height, function(current) {
   result[current.x][current.y] = current.distance;
  });

  return result;
 },

 getGradientPath: function(startPosition, maxLength, gradientFn) {
  var result = [];

  var currentValue = gradientFn(startPosition);
  var current = startPosition;
  var nextValue = 0;
  var next = null;
  var foundPath = true;

  while (maxLength > 0 && foundPath) {
   foundPath = false;

   // Check if we can move left.
   if (current.x > 0 && this.data.tiles[current.x][current.y][2] == 0) {
    var value = gradientFn({
     x: current.x - 1,
     y: current.y
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x - 1,
      y: current.y
     };
     foundPath = true;
    }
   }

   // Check if we can move right.
   if (current.x < this.width - 1 && this.data.tiles[current.x + 1][current.y][2] == 0) {
    var value = gradientFn({
     x: current.x + 1,
     y: current.y
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x + 1,
      y: current.y
     };
     foundPath = true;
    }
   }

   // Check if we can move down.
   if (current.y < this.height - 1 && this.data.tiles[current.x][current.y + 1][1] == 0) {
    var value = gradientFn({
     x: current.x,
     y: current.y + 1
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x,
      y: current.y + 1
     };
     foundPath = true;
    }
   }

   // Check if we can move up.
   if (current.y > 0 && this.data.tiles[current.x][current.y][1] == 0) {
    var value = gradientFn({
     x: current.x,
     y: current.y - 1
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x,
      y: current.y - 1
     };
     foundPath = true;
    }
   }

   // Check if we can move left-down.
   if (current.x > 0 && current.y < this.height - 1 && this.data.tiles[current.x][current.y][2] == 0 && this.data.tiles[current.x][current.y + 1][2] == 0 && this.data.tiles[current.x][current.y + 1][1] == 0 && this.data.tiles[current.x - 1][current.y + 1][1] == 0) {
    var value = gradientFn({
     x: current.x - 1,
     y: current.y + 1
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x - 1,
      y: current.y + 1
     };
     foundPath = true;
    }
   }

   // Check if we can move right-down.
   if (current.x < this.width - 1 && current.y < this.height - 1 && this.data.tiles[current.x + 1][current.y][2] == 0 && this.data.tiles[current.x + 1][current.y + 1][2] == 0 && this.data.tiles[current.x][current.y + 1][1] == 0 && this.data.tiles[current.x + 1][current.y + 1][1] == 0) {
    var value = gradientFn({
     x: current.x + 1,
     y: current.y + 1
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x + 1,
      y: current.y + 1
     };
     foundPath = true;
    }
   }

   // Check if we can move left-up.
   if (current.x > 0 && current.y > 0 && this.data.tiles[current.x][current.y][2] == 0 && this.data.tiles[current.x][current.y - 1][2] == 0 && this.data.tiles[current.x][current.y][1] == 0 && this.data.tiles[current.x - 1][current.y][1] == 0) {
    var value = gradientFn({
     x: current.x - 1,
     y: current.y - 1
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x - 1,
      y: current.y - 1
     };
     foundPath = true;
    }
   }

   // Check if we can move right-up.
   if (current.x < this.width - 1 && current.y > 0 && this.data.tiles[current.x + 1][current.y][2] == 0 && this.data.tiles[current.x + 1][current.y - 1][2] == 0 && this.data.tiles[current.x][current.y][1] == 0 && this.data.tiles[current.x + 1][current.y][1] == 0) {
    var value = gradientFn({
     x: current.x + 1,
     y: current.y - 1
    });
    if (value > currentValue) {
     currentValue = value;
     next = {
      x: current.x + 1,
      y: current.y - 1
     };
     foundPath = true;
    }
   }

   if (foundPath) {
    result.push(next);
   }

   --maxLength;
   current = next;
  }

  return result;
 },

 getPathAwayFrom: function(startPosition, fromPosition, maxLength, deadEndWeight) {
  var distances = this.distances[fromPosition.x][fromPosition.y];

  var self = this;
  var path = this.getGradientPath(startPosition, maxLength, function(current) {
   return distances[current.x][current.y] - self.deadEndPenalties[current.x][current.y] * deadEndWeight;
  });

  return path;
 },

 getPathAwayFromWithThreats: function(startPosition, fromPosition, maxLength, deadEndWeight, threatMap, threatWeight) {
  var distances = this.distances[fromPosition.x][fromPosition.y];

  var self = this;
  var path = this.getGradientPath(startPosition, maxLength, function(current) {
   return distances[current.x][current.y] - self.deadEndPenalties[current.x][current.y] * deadEndWeight - threatMap.get(current) * threatWeight;
  });

  return path;
 },

 getPathAwayWithMultipleDistancesAndThreats: function(startPosition, maxLength, deadEndWeight, distancesArray, threatMap, threatWeight) {
  var self = this;
  var path = this.getGradientPath(startPosition, maxLength, function(current) {
   var distance = 0;
   for (var i = 0; i < distancesArray.length; ++i) {
    distance += distancesArray[i][current.x][current.y];
   }
   distance /= distancesArray.length;
   return distance - self.deadEndPenalties[current.x][current.y] * deadEndWeight - threatMap.get(current) * threatWeight;
  });

  return path;
 },

 getShortestPathWithGraph: function(startPosition, endPosition, weights, lengthWeight) {
  var result = null;

  if (weights !== undefined) {
   result = this.dijkstra.shortestPath(this.vertices[startPosition.x][startPosition.y], this.vertices[endPosition.x][endPosition.y], {
    edgeCost: function(e) {
     return weights[e.data.x][e.data.y] + e.data.length * lengthWeight;
    }
    /*,
                    edgeFilter: function(e) {
                        return weights[e.data.x][e.data.y] < 1;
                    }*/
   });
  } else {
   result = this.dijkstra.shortestPath(this.vertices[startPosition.x][startPosition.y], this.vertices[endPosition.x][endPosition.y], {
    edgeCost: function(e) {
     return e.data.length;
    }
   });
  }

  if (result !== null) {
   return result.map(function(e) {
    return e.data;
   });
  } else {
   return [];
  }
 },

 _calculateDeadEndPenalties: function() {
  var result = new Array(this.width);
  for (var i = 0; i < this.width; ++i) {
   result[i] = new Array(this.height);
   for (var j = 0; j < this.height; ++j) {
    result[i][j] = 0;
   }
  }

  var worklist = [];
  for (var i = 0; i < this.reachable.length; ++i) {
   var current = this.reachable[i];
   var numExits = 0;

   // Check if we can move left.
   if (current.x > 0 && this.data.tiles[current.x][current.y][2] == 0) {
    ++numExits;
   }
   // Check if we can move right.
   if (current.x < this.width - 1 && this.data.tiles[current.x + 1][current.y][2] == 0) {
    ++numExits;
   }
   // Check if we can move down.
   if (current.y < this.height - 1 && this.data.tiles[current.x][current.y + 1][1] == 0) {
    ++numExits;
   }
   // Check if we can move up.
   if (current.y > 0 && this.data.tiles[current.x][current.y][1] == 0) {
    ++numExits;
   }

   if (numExits == 1) {
    worklist.push({
     x: current.x,
     y: current.y
    });
   }
  }

  while (worklist.length > 0) {
   var current = worklist.shift();

   var numExits = 0;
   var next = null;
   var penalty = Constants.MAZE_MAX_DEAD_END_PENALTY;

   // Check if we can move left.
   if (current.x > 0 && this.data.tiles[current.x][current.y][2] == 0) {
    // Check if left is not a dead end already.
    // If it is not, count it as an exit and add it for potential future processing.
    if (result[current.x - 1][current.y] == 0) {
     ++numExits;
     next = {
      x: current.x - 1,
      y: current.y
     };
    } else {
     penalty = Math.max(1, Math.min(penalty, result[current.x - 1][current.y] - 1));
    }
   }

   // Check if we can move right.
   if (current.x < this.width - 1 && this.data.tiles[current.x + 1][current.y][2] == 0) {
    if (result[current.x + 1][current.y] == 0) {
     ++numExits;
     next = {
      x: current.x + 1,
      y: current.y
     };
    } else {
     penalty = Math.max(1, Math.min(penalty, result[current.x + 1][current.y] - 1));
    }
   }

   // Check if we can move down.
   if (current.y < this.height - 1 && this.data.tiles[current.x][current.y + 1][1] == 0) {
    if (result[current.x][current.y + 1] == 0) {
     ++numExits;
     next = {
      x: current.x,
      y: current.y + 1
     };
    } else {
     penalty = Math.max(1, Math.min(penalty, result[current.x][current.y + 1] - 1));
    }
   }

   // Check if we can move up.
   if (current.y > 0 && this.data.tiles[current.x][current.y][1] == 0) {
    if (result[current.x][current.y - 1] == 0) {
     ++numExits;
     next = {
      x: current.x,
      y: current.y - 1
     };
    } else {
     penalty = Math.max(1, Math.min(penalty, result[current.x][current.y - 1] - 1));
    }
   }

   // There were at most one exit, so we can now mark this tile as a dead end.
   if (numExits <= 1) {
    result[current.x][current.y] = penalty;
   }

   // There was exactly one exit, so we should add the free neighbour for processing.
   if (numExits == 1) {
    worklist.push(next);
   }
  }

  this.deadEndPenalties = result;
 }

});

if (typeof module === 'object') {
 module.exports = Maze;
}

;
if (typeof require === 'function') {
 var Classy = require('./classy');
 var Box2D = require('./box2d');
 var ProjectileState = require('./projectilestate');
 var Log = require('./log');
}
var Projectile = Classy.newClass().name('Projectile');
Projectile.fields({
 id: null,
 playerId: null,
 type: 0,
 x: 0.0,
 y: 0.0,
 speedX: 0.0,
 speedY: 0.0,
 lifetime: 0.0,
 timeoutWindow: 0,
 timeoutBounceCount: 0,
 b2dbody: null,
 roundModel: null,
 timeAlive: 0.0,
 deadlyToOwner: false,
 initialSpeedSquared: 0,
 initialSpeed: 0,
 stopped: false,
 bounces: [],
 evtHandler: null,
 evtContext: null,
 log: null
});
Projectile.constructor(function(projectileState, lifetime, timeoutWindow, timeoutBounceCount, roundModel, evtHandler, evtContext) {
 this.setProjectileState(projectileState);
 this.timeAlive = 0.0;
 this.lifetime = lifetime;
 this.timeoutWindow = timeoutWindow;
 this.timeoutBounceCount = timeoutBounceCount;
 this.deadlyToOwner = false;
 this.initialSpeedSquared = this.speedX * this.speedX + this.speedY * this.speedY;
 this.initialSpeed = Math.sqrt(this.initialSpeedSquared);
 this.stopped = false;
 this.bounces = [];
 this.roundModel = roundModel;
 this.evtHandler = evtHandler;
 this.evtContext = evtContext;
 this.log = Log.create('Projectile');
});
Projectile.methods({
 getId: function() {
  return this.id;
 },
 getPlayerId: function() {
  return this.playerId;
 },
 getType: function() {
  return this.type;
 },
 setX: function(x) {
  this.x = x;
 },
 getX: function() {
  return this.x;
 },
 setY: function(y) {
  this.y = y;
 },
 getY: function() {
  return this.y;
 },
 setSpeedX: function(speedX) {
  this.speedX = speedX;
 },
 getSpeedX: function() {
  return this.speedX;
 },
 setSpeedY: function(speedY) {
  this.speedY = speedY;
 },
 getSpeedY: function() {
  return this.speedY;
 },
 setB2DBody: function(b2dbody) {
  this.b2dbody = b2dbody;
 },
 getB2DBody: function() {
  return this.b2dbody;
 },
 isDeadlyToOwner: function() {
  return this.deadlyToOwner;
 },
 makeDeadlyToOwner: function() {
  this.deadlyToOwner = true;
 },
 getTimeAlive: function() {
  return this.timeAlive;
 },
 setProjectileState: function(projectileState) {
  this.id = projectileState.getId();
  this.playerId = projectileState.getPlayerId();
  this.x = projectileState.getX();
  this.y = projectileState.getY();
  this.speedX = projectileState.getSpeedX();
  this.speedY = projectileState.getSpeedY();
  this.type = projectileState.getType();
  if (this.b2dbody) {
   this.b2dbody.SetPosition(Box2D.Common.Math.b2Vec2.Make(this.x, this.y));
   this.b2dbody.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(this.speedX, this.speedY));
  }
 },
 getProjectileState: function() {
  var ps = ProjectileState.withState(this.id, this.playerId, this.type, this.x, this.y, this.speedX, this.speedY);
  return ps;
 },
 update: function(deltaTime) {
  this.timeAlive += deltaTime;
  var currentTimeout = new Date().getTime() - this.timeoutWindow;
  for (var i = 0; i < this.bounces.length; ++i) {
   if (this.bounces[i] >= currentTimeout) {
    this.bounces.splice(0, i);
    break;
   }
  }
  if (Math.abs(this.b2dbody.GetLinearVelocity().LengthSquared() - this.initialSpeedSquared) > 0.01) {
   var velocity = this.b2dbody.GetLinearVelocity();
   var length = velocity.Length();
   if (length === 0) {
    this.stopped = true;
   } else {
    velocity.Multiply(this.initialSpeed / length);
   }
  }
  this.x = this.b2dbody.GetPosition().x;
  this.y = this.b2dbody.GetPosition().y;
  this.speedX = this.b2dbody.GetLinearVelocity().x;
  this.speedY = this.b2dbody.GetLinearVelocity().y;
 },
 hitShield: function() {
  this.bounces.push(new Date().getTime());
 },
 hitMaze: function() {
  this.bounces.push(new Date().getTime());
 },
 done: function() {
  return this.timeAlive >= this.lifetime || this.stopped || this.bounces.length >= this.timeoutBounceCount;
 },
 _emitEvent: function(evt, data) {
  if (this.evtHandler && this.evtContext) {
   this.evtHandler(this.evtContext, evt, data);
  }
 }
});
if (typeof module === 'object') {
 module.exports = Projectile;
};
if (typeof require === 'function') {
 var Constants = require('./constants');
 var Projectile = require('./projectile');
}
var Shrapnel = Projectile.subclass();
Shrapnel.methods({
 update: function(deltaTime) {
  if (!this.isDeadlyToOwner()) {
   this.makeDeadlyToOwner();
  }
  this.x = this.b2dbody.GetPosition().x;
  this.y = this.b2dbody.GetPosition().y;
  this.speedX = this.b2dbody.GetLinearVelocity().x;
  this.speedY = this.b2dbody.GetLinearVelocity().y;
 },
 hitShield: function() {
  var velocity = this.b2dbody.GetLinearVelocity();
  velocity.Multiply(0.0);
 },
 hitMaze: function() {
  var velocity = this.b2dbody.GetLinearVelocity();
  velocity.Multiply(0.0);
 },
 done: function() {
  var velocity = this.b2dbody.GetLinearVelocity();
  return velocity.LengthSquared() <= 0.01;
 }
});
if (typeof module === 'object') {
 module.exports = Shrapnel;
};
if (typeof require === 'function') {
 var Constants = require('./constants');
 var Projectile = require('./projectile');
}
var Shotgun = Projectile.subclass();
Shotgun.methods({
 hitShield: function() {
  this._super();
  this.timeAlive = Math.max(this.timeAlive, Constants.SHOTGUN_MAX_LIFETIME - Constants.SHOTGUN_LIFETIME_AFTER_MAZE_HIT);
 },
 hitMaze: function() {
  this._super();
  this.timeAlive = Math.max(this.timeAlive, Constants.SHOTGUN_MAX_LIFETIME - Constants.SHOTGUN_LIFETIME_AFTER_MAZE_HIT);
 }
});
if (typeof module === 'object') {
 module.exports = Shotgun;
};
if (typeof require === 'function') {
 var Constants = require('./constants');
 var Box2D = require('./box2d');
 var B2DUtils = require('./b2dutils');
 var Weapon = require('./weapon');
 var Projectile = require('./projectile');
 var TargetChange = require('./targetchange');
}
var HomingMissile = Projectile.subclass().name('HomingMissile');
HomingMissile.fields({
 currentTargetPlayerId: null
});
HomingMissile.methods({
 update: function(deltaTime) {
  this.timeAlive += deltaTime;
  var currentTimeout = new Date().getTime() - this.timeoutWindow;
  for (var i = 0; i < this.bounces.length; ++i) {
   if (this.bounces[i] >= currentTimeout) {
    this.bounces.splice(0, i);
    break;
   }
  }
  if (this.timeAlive > Constants.HOMING_MISSILE_ACTIVATION_TIME) {
   if (!this.isDeadlyToOwner()) {
    this.makeDeadlyToOwner();
   }
   var tanks = this.roundModel.getTanks();
   var maze = this.roundModel.getMaze();
   if (maze) {
    var shortestDistance = null;
    var targetPosition = null;
    var targetPlayerId = null;
    var startPosition = {
     x: Math.floor(this.x / Constants.MAZE_TILE_SIZE.m),
     y: Math.floor(this.y / Constants.MAZE_TILE_SIZE.m)
    };
    var distances = maze.getDistancesFromPosition(startPosition);
    if (distances !== false) {
     for (var tank in tanks) {
      var endPosition = {
       x: Math.floor(tanks[tank].getX() / Constants.MAZE_TILE_SIZE.m),
       y: Math.floor(tanks[tank].getY() / Constants.MAZE_TILE_SIZE.m)
      };
      var currentDistance = maze.getDistanceToPosition(distances, endPosition);
      if (currentDistance !== false) {
       if (shortestDistance === null || currentDistance < shortestDistance || (currentDistance === shortestDistance && tank !== this.getPlayerId())) {
        shortestDistance = currentDistance;
        targetPosition = endPosition;
        targetPlayerId = tank;
       }
      }
     }
    }
    if (targetPlayerId) {
     if (shortestDistance <= 1) {
      targetPosition.x = tanks[targetPlayerId].getX();
      targetPosition.y = tanks[targetPlayerId].getY();
     } else {
      var shortestPath = maze.getShortestPathWithGraph(startPosition, targetPosition);
      targetPosition.x = (shortestPath[0].x + 0.5) * Constants.MAZE_TILE_SIZE.m;
      targetPosition.y = (shortestPath[0].y + 0.5) * Constants.MAZE_TILE_SIZE.m;
     }
     var relativeToMissile = B2DUtils.toLocalSpace(this.b2dbody, targetPosition);
     var newSpeedX = this.b2dbody.GetLinearVelocity().x;
     var newSpeedY = this.b2dbody.GetLinearVelocity().y;
     if (relativeToMissile.x < 0) {
      newSpeedX -= Constants.HOMING_MISSILE.ACCELERATION * deltaTime;
     } else {
      newSpeedX += Constants.HOMING_MISSILE.ACCELERATION * deltaTime;
     }
     if (relativeToMissile.y < 0) {
      newSpeedY -= Constants.HOMING_MISSILE.ACCELERATION * deltaTime;
     } else {
      newSpeedY += Constants.HOMING_MISSILE.ACCELERATION * deltaTime;
     }
     this.b2dbody.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(newSpeedX, newSpeedY));
    }
    if (targetPlayerId !== this.currentTargetPlayerId) {
     var targetChange = TargetChange.create(this.id, targetPlayerId);
     this._emitEvent(Weapon._EVENTS.HOMING_MISSILE_TARGET_CHANGED, targetChange);
    }
    this.currentTargetPlayerId = targetPlayerId;
   }
  }
  if (this.b2dbody.GetLinearVelocity().LengthSquared() - this.initialSpeedSquared > 0.01) {
   var velocity = this.b2dbody.GetLinearVelocity();
   var length = velocity.Length();
   velocity.Multiply(this.initialSpeed / length);
  }
  this.x = this.b2dbody.GetPosition().x;
  this.y = this.b2dbody.GetPosition().y;
  this.speedX = this.b2dbody.GetLinearVelocity().x;
  this.speedY = this.b2dbody.GetLinearVelocity().y;
 }
});
if (typeof module === 'object') {
 module.exports = HomingMissile;
};
if (typeof require === 'function') {
 var Classy = require('./classy');
 var Box2D = require('./box2d');
 var TrapState = require('./trapstate');
 var Log = require('./log');
}
var Trap = Classy.newClass().name('Trap');
Trap.fields({
 id: null,
 playerId: null,
 type: 0,
 x: 0.0,
 y: 0.0,
 speedX: 0.0,
 speedY: 0.0,
 b2dbody: null,
 roundModel: null,
 timeAlive: 0.0,
 evtHandler: null,
 evtContext: null,
 log: null
});
Trap.constructor(function(trapState, roundModel, evtHandler, evtContext) {
 this.setTrapState(trapState);
 this.timeAlive = 0.0, this.roundModel = roundModel;
 this.evtHandler = evtHandler;
 this.evtContext = evtContext;
 this.log = Log.create('Trap');
});
Trap.classMethods({
 createInitialTrapState: function(id, playerId, type, x, y, speedX, speedY, fieldsJSON) {
  var trapState = TrapState.withState(id, playerId, type, x, y, speedX, speedY, fieldsJSON);
  return trapState;
 }
});
Trap.methods({
 getId: function() {
  return this.id;
 },
 getPlayerId: function() {
  return this.playerId;
 },
 getType: function() {
  return this.type;
 },
 setX: function(x) {
  this.x = x;
 },
 getX: function() {
  return this.x;
 },
 setY: function(y) {
  this.y = y;
 },
 getY: function() {
  return this.y;
 },
 setSpeedX: function(speedX) {
  this.speedX = speedX;
 },
 getSpeedX: function() {
  return this.speedX;
 },
 setSpeedY: function(speedY) {
  this.speedY = speedY;
 },
 getSpeedY: function() {
  return this.speedY;
 },
 setB2DBody: function(b2dbody) {
  this.b2dbody = b2dbody;
 },
 getB2DBody: function() {
  return this.b2dbody;
 },
 getTimeAlive: function() {
  return this.timeAlive;
 },
 update: function(deltaTime) {
  this.log.error("Attempt to call Trap.update. update() must be overridden in subclasses");
 },
 trip: function(playerId, entered) {
  this.log.error("Attempt to call Trap.trip. trip() must be overridden in subclasses");
 },
 released: function() {
  this.log.error("Attempt to call Trap.released. released() must be overridden in subclasses");
 },
 getProjectileStates: function() {
  this.log.error("Attempt to call Trap.getProjectileStates. getProjectileStates() must be overridden in subclasses");
 },
 done: function() {
  this.log.error("Attempt to call Trap.done. done() must be overridden in subclasses");
 },
 setTrapState: function(trapState) {
  this.id = trapState.getId();
  this.playerId = trapState.getPlayerId();
  this.x = trapState.getX();
  this.y = trapState.getY();
  this.speedX = trapState.getSpeedX();
  this.speedY = trapState.getSpeedY();
  this.type = trapState.getType();
  this._setFields(trapState.getFields());
  if (this.b2dbody) {
   this.b2dbody.SetPosition(Box2D.Common.Math.b2Vec2.Make(this.x, this.y));
   this.b2dbody.SetLinearVelocity(Box2D.Common.Math.b2Vec2.Make(this.speedX, this.speedY));
  }
 },
 getTrapState: function() {
  var ts = TrapState.withState(this.id, this.playerId, this.type, this.x, this.y, this.speedX, this.speedY, JSON.stringify(this.getFields()));
  return ts;
 },
 getField: function(fieldName) {
  if (this.classs().hasOwnField("_" + fieldName)) {
   return this["_" + fieldName];
  } else {
   return null;
  }
 },
 getFields: function() {
  var fields = this.classs().listOwnFields();
  var fieldsObj = {};
  for (var i = 0; i < fields.length; ++i) {
   fieldsObj[fields[i]] = this[fields[i]];
  }
  return fieldsObj;
 },
 _emitEvent: function(evt, data) {
  if (this.evtHandler && this.evtContext) {
   this.evtHandler(this.evtContext, evt, data);
  }
 },
 _setFields: function(fieldsObj) {
  var fields = this.classs().listOwnFields();
  for (var i = 0; i < fields.length; ++i) {
   this[fields[i]] = fieldsObj[fields[i]];
  }
 }
});
if (typeof module === 'object') {
 module.exports = Trap;
}
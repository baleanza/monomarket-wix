module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60, max-age=0');
  res.status(200).send('<?xml version=\"1.0\" encoding=\"UTF-8\"?><stock/>');
};
